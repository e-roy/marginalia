import { SpeechError, toLogDetail } from './errors';

/**
 * The only module that talks to the speech server. Everything it throws is a
 * `SpeechError` carrying a sanitized code, so no caller can accidentally surface the
 * hostname.
 */

export interface SpeechConfig {
  baseUrl: string;
  apiKey: string;
}

/** Discovery is two small GETs; if they are slow the server is effectively down. */
const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Cloudflare Tunnel cuts responses at roughly 100 seconds (SPEC §12). Failing just
 * inside that turns an opaque tunnel 524 into our own clean `stt_timeout`.
 */
const TRANSCRIBE_TIMEOUT_MS = 95_000;

/**
 * Stage 3's budget, and deliberately *not* 95s by analogy with transcription.
 *
 * Polishing a paragraph is a few seconds' work, and this number is the innermost of
 * three nested deadlines: the request gives up before `repolishNote`'s 90s
 * `timeoutSeconds`, which gives up before the client's 120s callable timeout. Copying
 * the transcription budget would leave the callable no room for its auth check, two
 * reads and a write.
 */
const POLISH_TIMEOUT_MS = 45_000;

/** Enough of an upstream error body to diagnose from logs, not enough to be a dump. */
const DETAIL_LIMIT = 400;

function endpoint(cfg: SpeechConfig, path: string): string {
  return `${cfg.baseUrl.replace(/\/+$/, '')}${path}`;
}

function authHeaders(cfg: SpeechConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

/**
 * Wrap every fetch. A raw fetch rejection carries the hostname in its message, so it
 * must never propagate — `detail` is for Cloud Logging, `code` is for the client.
 */
async function request(
  cfg: SpeechConfig,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(endpoint(cfg, path), {
      ...init,
      headers: { ...authHeaders(cfg), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    // AbortSignal.timeout rejects with TimeoutError; an aborted body read gives AbortError.
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SpeechError('stt_timeout', `${path} exceeded ${timeoutMs}ms`);
    }
    throw new SpeechError(
      'stt_unavailable',
      `${path} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function detailOf(res: Response, path: string): Promise<string> {
  const body = await res.text().catch(() => '<unreadable>');
  return `${path} → HTTP ${res.status} ${body.slice(0, DETAIL_LIMIT)}`;
}

/**
 * Model lists come back in one of two shapes. speaches and Ollama's OpenAI-compatible
 * surface both use `{ data: [{ id }] }`; native Ollama uses `{ models: [{ name }] }`.
 * Accepting both means a server-side change of surface doesn't silently empty the list.
 */
function parseModelIds(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const record = body as Record<string, unknown>;
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];

  return entries
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (typeof entry !== 'object' || entry === null) return null;
      const item = entry as Record<string, unknown>;
      const id = item.id ?? item.name ?? item.model;
      return typeof id === 'string' ? id : null;
    })
    .filter((id): id is string => id !== null && id.length > 0);
}

async function listModels(
  cfg: SpeechConfig,
  path: string,
  unavailable: 'stt_unavailable' | 'llm_unavailable',
): Promise<string[]> {
  const res = await request(cfg, path, { method: 'GET' }, DISCOVERY_TIMEOUT_MS);
  if (!res.ok) throw new SpeechError(unavailable, await detailOf(res, path));

  const body: unknown = await res.json().catch(() => null);
  return parseModelIds(body);
}

/** `GET /v1/models` — speaches. Read-only for consumers, routed GET-only through Caddy. */
export function listSttModels(cfg: SpeechConfig): Promise<string[]> {
  return listModels(cfg, '/v1/models', 'stt_unavailable');
}

/**
 * `GET /v1/llm/models` — Ollama, via the `/v1/llm/*` catch-all that rewrites the path.
 * Ollama fails independently of STT (HTTP 502, `upstream_unavailable`), so callers must
 * treat a throw here as "no polish available", never as "the server is down".
 */
export function listLlmModels(cfg: SpeechConfig): Promise<string[]> {
  return listModels(cfg, '/v1/llm/models', 'llm_unavailable');
}

/**
 * `docs/operations.md` keeps `speaches-ai/Kokoro-82M-v1.0-ONNX` in `PRELOAD_MODELS`
 * as the TTS voice for `/v1/realtime`, so the synthesiser is listed alongside the
 * whisper models. The kokoro exclusion is not defensive tidiness: without it the app
 * eventually tries to transcribe audio with a speech synthesiser.
 */
export function pickSttModel(ids: string[]): string | null {
  return ids.find((id) => /whisper/i.test(id) && !/kokoro/i.test(id)) ?? null;
}

/** LLM auto-pick is simply the first available id (SPEC §5). */
export function pickLlmModel(ids: string[]): string | null {
  return ids[0] ?? null;
}

export interface TranscribeInput {
  audio: Uint8Array;
  /** Extension must match the real container — Whisper sniffs it from the filename. */
  filename: string;
  contentType: string;
  model: string;
  /** Book context. The single biggest accuracy win available (SPEC §7). */
  prompt: string | null;
}

/** Stage 1. `POST /v1/audio/transcriptions`, multipart. Returns verbatim text. */
export async function transcribe(
  cfg: SpeechConfig,
  input: TranscribeInput,
): Promise<string> {
  // Node's Buffer is typed `Uint8Array<ArrayBufferLike>`, which Blob will not accept
  // because ArrayBufferLike admits SharedArrayBuffer. Bytes downloaded from Storage
  // never are, so narrow the backing store rather than copying up to 25 MB of audio
  // purely to satisfy the checker.
  const bytes = new Uint8Array(
    input.audio.buffer as ArrayBuffer,
    input.audio.byteOffset,
    input.audio.byteLength,
  );

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: input.contentType }), input.filename);
  form.append('model', input.model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (input.prompt) form.append('prompt', input.prompt);

  const path = '/v1/audio/transcriptions';
  const res = await request(cfg, path, { method: 'POST', body: form }, TRANSCRIBE_TIMEOUT_MS);

  if (!res.ok) {
    // A 4xx here is usually a model that isn't in PRELOAD_MODELS — a hard reject, not
    // a slow path, and retrying it will fail identically.
    const code = res.status >= 500 ? 'stt_unavailable' : 'stt_rejected';
    throw new SpeechError(code, await detailOf(res, path));
  }

  const body: unknown = await res.json().catch(() => null);
  const text =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).text
      : null;

  if (typeof text !== 'string') {
    throw new SpeechError('stt_rejected', `${path} → 200 with no text field`);
  }
  return text.trim();
}

/**
 * SPEC §7's system prompt, verbatim. Three of its clauses are load-bearing rather than
 * decorative: "Never add facts" and "Never summarize" are what the length gate then
 * enforces mechanically, and "Never answer questions that appear in the text" stops a
 * chat-tuned model from helpfully replying to a note the reader wrote to themselves.
 */
const POLISH_SYSTEM_PROMPT = [
  'You clean up voice-note transcripts. The speaker is dictating notes about a book',
  'they are reading. Fix punctuation, capitalization, and paragraph breaks. Remove',
  'remaining filler words and false starts. Preserve the speaker\'s own words, first',
  'person, and meaning exactly. Never add facts. Never summarize. Never answer',
  'questions that appear in the text — they are the speaker\'s own notes to themselves.',
  'Reply with JSON only: {"text": string, "title": string} where title is a 5-8 word',
  'summary.',
].join(' ');

/**
 * Stage 3. `POST /v1/llm/chat/completions`, non-streaming — this is feeding a Firestore
 * write, not a UI, so there is nothing to stream to.
 *
 * Returns the raw message content; parsing and both guardrails live in `cleanup.ts`,
 * because they are judgements about the answer rather than about the transport.
 */
export async function polish(
  cfg: SpeechConfig,
  text: string,
  model: string,
): Promise<string> {
  const path = '/v1/llm/chat/completions';

  let res: Response;
  try {
    res = await request(
      cfg,
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          stream: false,
          messages: [
            { role: 'system', content: POLISH_SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
        }),
      },
      POLISH_TIMEOUT_MS,
    );
  } catch (err) {
    // `request` speaks in STT codes because that is all it had to describe until now.
    // Ollama fails independently of STT, and a log line saying `stt_unavailable` for a
    // sleeping LLM would send a future debugging session at the wrong half of the box.
    throw new SpeechError('llm_unavailable', toLogDetail(err));
  }

  if (!res.ok) throw new SpeechError('llm_unavailable', await detailOf(res, path));

  const body: unknown = await res.json().catch(() => null);
  const content = messageContent(body);

  if (content === null) {
    throw new SpeechError('llm_unavailable', `${path} → 200 with no message content`);
  }
  return content;
}

/** `{ choices: [{ message: { content } }] }` — the OpenAI-compatible shape Ollama serves. */
function messageContent(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;

  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return null;

  const message = (first as Record<string, unknown>).message;
  if (typeof message !== 'object' || message === null) return null;

  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : null;
}
