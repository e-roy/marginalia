import { SpeechError } from './errors';

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

/** LLM auto-pick is simply the first available id (SPEC §5). Stage 3 lands in M4. */
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
