import * as logger from 'firebase-functions/logger';

import { toLogDetail } from './errors';
import { listLlmModels, pickLlmModel, polish, type SpeechConfig } from './speech';
import type { SettingsDoc } from './types';

/**
 * Stage 2 of the cleanup pipeline (SPEC §7), and its mandatory guardrails.
 *
 * The single most important property of this module: **`runCleanup` cannot throw an
 * LLM error.** `transcribeNote` runs it inside the try block whose catch classifies
 * failures into `pending` / `failed` and schedules retries (ADR-008). Ollama fails
 * independently of STT and is asleep more often than not, so a polish failure reaching
 * that classifier would turn "the cleanup is unavailable" into "the transcript failed"
 * — the exact outcome SPEC §7 says must never happen. Every LLM failure is caught here
 * and answered with `cleanText: null`, which the UI reads as "show the transcript".
 *
 * The callable in `repolishNote.ts` wants the opposite behaviour and gets it by reading
 * `llmModel`: swallowing the failure is right when the alternative is no note at all,
 * and wrong when the user explicitly asked and the alternative is the note they had.
 *
 * **The model sees `rawText`, verbatim.** There was once a deterministic filler strip
 * in front of it, and it was a mistake — see ADR-016. Whatever a regex removes is
 * removed from the model's evidence too, and it cannot ask for it back. Deciding what
 * is a false start and what is emphasis is a judgement about meaning, which is the one
 * thing the model has a system prompt for and a regex can never do.
 */

/** `settings.llmModel === 'none'` means the user turned polish off (SPEC §6). */
export const NO_POLISH = 'none';

/**
 * Models like to wrap JSON in a fence even when told to reply with JSON only.
 */
function unfence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/**
 * Reasoning models emit `<think>…</think>`. SPEC §7 says to assume this rather than
 * test for it, because the model is whatever Ollama happens to have pulled.
 *
 * Two shapes, not one: some runtimes put the *opening* tag in the chat template rather
 * than the model's output, so the reply begins mid-reasoning and only the closing tag
 * ever appears. Handling just the matched pair would leave that whole monologue sitting
 * in front of the JSON.
 */
export function stripReasoning(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');

  const close = out.lastIndexOf('</think>');
  if (close !== -1) out = out.slice(close + '</think>'.length);

  return out.trim();
}

export interface Polished {
  text: string;
  title: string | null;
}

/**
 * Parse the polish reply. Returns null for anything unusable, which the caller treats
 * exactly like the LLM being down — the raw transcript survives either way.
 */
export function parsePolish(content: string): Polished | null {
  const body = unfence(stripReasoning(content));

  // The whole body first, then the outermost brace pair — which recovers the common
  // case of a model adding a sentence of commentary either side of the JSON.
  const candidates = [body];
  const open = body.indexOf('{');
  const close = body.lastIndexOf('}');
  if (open !== -1 && close > open) candidates.push(body.slice(open, close + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;

    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (text.length === 0) continue;

    const title = typeof record.title === 'string' ? record.title.trim() : '';
    return { text, title: title.length > 0 ? title : null };
  }

  return null;
}

/**
 * The guardrail that matters most. A small model quietly summarizing a note into
 * oblivion is the most likely failure mode in the whole system, and it is invisible —
 * the result reads perfectly well, it is just no longer what was said (SPEC §7).
 *
 * Measured against `rawText`, which is the only ground truth there is: it is what the
 * speaker actually said, and the polish is only trustworthy insofar as it still says
 * the same thing. The floor leaves room for genuine filler removal without leaving
 * room for a summary.
 *
 * An empty base rejects everything, which is why nothing offers to polish a recording
 * that caught only silence.
 */
const MIN_RATIO = 0.6;
const MAX_RATIO = 1.4;

export function withinLengthGate(input: string, output: string): boolean {
  if (input.length === 0) return false;
  const ratio = output.length / input.length;
  return ratio >= MIN_RATIO && ratio <= MAX_RATIO;
}

export interface CleanupResult {
  /** Null whenever the polish did not happen — the UI then shows `rawText`. */
  cleanText: string | null;
  title: string | null;
  /** Null whenever the polish did not contribute — disabled, unreachable, or rejected. */
  llmModel: string | null;
}

export async function runCleanup(
  cfg: SpeechConfig,
  rawText: string,
  settings: SettingsDoc | null,
): Promise<CleanupResult> {
  /**
   * What every exit below returns. Not a degraded copy of the text — the note already
   * has `rawText` and the UI falls back to it, so inventing a second nearly-identical
   * string would only be a worse version of something already stored.
   */
  const unpolished: CleanupResult = { cleanText: null, title: null, llmModel: null };

  if (rawText.trim().length === 0) return unpolished;
  if (settings?.llmModel === NO_POLISH) return unpolished;

  try {
    let model = settings?.llmModel ?? null;
    if (!model) {
      // Nothing pinned — discover and auto-pick. No model name is hardcoded anywhere
      // in this app (ADR-004): the server only serves its `PRELOAD_MODELS`.
      model = pickLlmModel(await listLlmModels(cfg));
      if (!model) {
        logger.info('cleanup: no LLM model available, keeping the transcript');
        return unpolished;
      }
    }

    const parsed = parsePolish(await polish(cfg, rawText, model));
    if (!parsed) {
      logger.warn('cleanup: polish reply was not usable JSON', { model });
      return unpolished;
    }

    if (!withinLengthGate(rawText, parsed.text)) {
      logger.warn('cleanup: polish rejected by the length gate', {
        model,
        inputChars: rawText.length,
        outputChars: parsed.text.length,
      });
      return unpolished;
    }

    return { cleanText: parsed.text, title: parsed.title, llmModel: model };
  } catch (err) {
    // Every LLM failure ends here. Polish is best-effort by construction, not by the
    // caller remembering to catch — see this module's header.
    logger.warn('cleanup: polish unavailable, keeping the transcript', {
      detail: toLogDetail(err),
    });
    return unpolished;
  }
}
