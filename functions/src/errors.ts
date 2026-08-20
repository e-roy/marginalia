/**
 * Error codes that are safe to surface to the client.
 *
 * Cloud Logging is private, so the real cause is logged in full server-side. What
 * reaches `note.error.message` must never contain the speech hostname or the failing
 * URL — an error shown in the UI can end up in a screenshot in a public issue
 * (SPEC §2, "Redact upstream URLs from client-facing errors").
 */
export type SpeechErrorCode =
  | 'stt_unavailable' // server unreachable, or 5xx
  | 'stt_timeout' // exceeded the tunnel's response window
  | 'stt_rejected' // 4xx — bad model, bad audio, bad key
  | 'llm_unavailable' // Ollama is down independently of STT
  | 'no_stt_model' // discovery returned nothing usable
  | 'audio_missing' // the Storage object vanished before it could be read
  | 'audio_too_large'
  | 'internal';

export class SpeechError extends Error {
  readonly code: SpeechErrorCode;

  /** Full cause, including the URL. For Cloud Logging only — never for Firestore. */
  readonly detail: string;

  constructor(code: SpeechErrorCode, detail: string) {
    // The message is the code itself, so an unhandled throw still cannot leak a
    // hostname into a stack trace that someone pastes into an issue.
    super(code);
    this.name = 'SpeechError';
    this.code = code;
    this.detail = detail;
  }
}

/** Narrow anything thrown to a code safe for the client. Unknown causes are opaque. */
export function toErrorCode(err: unknown): SpeechErrorCode {
  return err instanceof SpeechError ? err.code : 'internal';
}

/** What to write to Cloud Logging: full detail when we have it, never the raw error. */
export function toLogDetail(err: unknown): string {
  if (err instanceof SpeechError) return `${err.code}: ${err.detail}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * What the user actually reads. Deliberately vague about *where* anything is — these
 * strings are written to Firestore and rendered in the UI.
 */
const MESSAGES: Record<SpeechErrorCode, string> = {
  stt_unavailable: 'The speech server could not be reached. This will retry on its own.',
  stt_timeout: 'Transcription took too long. This will retry on its own.',
  stt_rejected: 'The speech server rejected this recording.',
  llm_unavailable: 'Cleanup is unavailable, so the raw transcript was kept.',
  no_stt_model: 'No transcription model is available on the server.',
  audio_missing: 'The recording was no longer available to transcribe.',
  audio_too_large: 'That recording is too long to transcribe.',
  internal: 'Something went wrong while transcribing.',
};

/** The `{ code, message }` pair written to `note.error`. Sanitized by construction. */
export function toClientError(err: unknown): { code: SpeechErrorCode; message: string } {
  const code = toErrorCode(err);
  return { code, message: MESSAGES[code] };
}
