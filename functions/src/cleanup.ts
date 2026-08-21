import * as logger from 'firebase-functions/logger';

import { toLogDetail } from './errors';
import { listLlmModels, pickLlmModel, polish, type SpeechConfig } from './speech';
import type { SettingsDoc } from './types';

/**
 * Stages 2 and 3 of the cleanup pipeline (SPEC §7), and both of its mandatory
 * guardrails.
 *
 * The single most important property of this module: **`runCleanup` cannot throw an
 * LLM error.** `transcribeNote` runs it inside the try block whose catch classifies
 * failures into `pending` / `failed` and schedules retries (ADR-008). Ollama fails
 * independently of STT and is asleep more often than not, so a polish failure reaching
 * that classifier would turn "the cleanup is unavailable" into "the transcript failed"
 * — the exact outcome SPEC §7 says must never happen. Every LLM failure is caught here
 * and answered with Stage 2 output and `llmModel: null`.
 *
 * The callable in `repolishNote.ts` wants the opposite behaviour and gets it by reading
 * `llmModel`: swallowing the failure is right when the alternative is no note at all,
 * and wrong when the user explicitly asked and the alternative is the note they had.
 */

/** `settings.llmModel === 'none'` means the user turned polish off (SPEC §6). */
export const NO_POLISH = 'none';

/**
 * Deliberately conservative, and deliberately not a judgement call — this runs offline
 * and must never depend on Ollama being awake. It does **not** strip `like`,
 * `you know`, `I mean`, `sort of` or `kind of`: those carry real meaning often enough
 * that removing them mechanically damages good sentences, so they are left to Stage 3,
 * which has the context to judge (SPEC §7).
 */
const FILLERS = /\b(?:um+|uh+|erm?|ah+|mm+|hmm+)\b[,.]?\s*/gi;
const REPEATS = /\b(\w+)(\s+\1\b)+/gi;

export function stripFillers(raw: string): string {
  return raw
    .replace(FILLERS, '')
    .replace(REPEATS, '$1')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
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

/** Models like to wrap JSON in a fence even when told to reply with JSON only. */
function unfence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

export interface Polished {
  text: string;
  title: string | null;
}

/**
 * Parse Stage 3's reply. Returns null for anything unusable, which the caller treats
 * exactly like the LLM being down — Stage 2 output survives either way.
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
  cleanText: string;
  title: string | null;
  /** Null whenever Stage 3 did not contribute — disabled, unreachable, or rejected. */
  llmModel: string | null;
}

export async function runCleanup(
  cfg: SpeechConfig,
  rawText: string,
  settings: SettingsDoc | null,
): Promise<CleanupResult> {
  const stripped = stripFillers(rawText);

  // What we fall back to at every exit below. Stage 2 is offline and deterministic, so
  // this much is always available.
  const stage2: CleanupResult = { cleanText: stripped, title: null, llmModel: null };

  if (stripped.length === 0) return stage2;
  if (settings?.llmModel === NO_POLISH) return stage2;

  try {
    let model = settings?.llmModel ?? null;
    if (!model) {
      // Nothing pinned — discover and auto-pick. No model name is hardcoded anywhere
      // in this app (ADR-004): the server only serves its `PRELOAD_MODELS`.
      model = pickLlmModel(await listLlmModels(cfg));
      if (!model) {
        logger.info('cleanup: no LLM model available, keeping Stage 2 text');
        return stage2;
      }
    }

    const parsed = parsePolish(await polish(cfg, stripped, model));
    if (!parsed) {
      logger.warn('cleanup: polish reply was not usable JSON', { model });
      return stage2;
    }

    if (!withinLengthGate(stripped, parsed.text)) {
      logger.warn('cleanup: polish rejected by the length gate', {
        model,
        inputChars: stripped.length,
        outputChars: parsed.text.length,
      });
      return stage2;
    }

    return { cleanText: parsed.text, title: parsed.title, llmModel: model };
  } catch (err) {
    // Every LLM failure ends here. Polish is best-effort by construction, not by the
    // caller remembering to catch — see this module's header.
    logger.warn('cleanup: polish unavailable, keeping Stage 2 text', {
      detail: toLogDetail(err),
    });
    return stage2;
  }
}
