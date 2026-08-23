import type { Timestamp } from 'firebase-admin/firestore';

/**
 * The slice of the Firestore data model the functions touch. Mirrors SPEC §6 — keep
 * the two in step. The client has its own copy in `src/lib/types.ts`; both describe
 * the same documents, and neither is generated from the other.
 */

export type NoteStatus = 'queued' | 'pending' | 'transcribing' | 'done' | 'failed';

export interface NoteDoc {
  source: 'voice' | 'text';
  bookId: string;
  bookTitle: string;
  chapter: number | null;
  status: NoteStatus;
  rawText: string | null;
  cleanText: string | null;
  title: string | null; // LLM-suggested, 5-8 words
  edited: boolean; // once hand-edited, re-polish won't overwrite
  durationMs: number | null;
  sttModel: string | null;
  llmModel: string | null; // null if polish was skipped or rejected
  audioPath: string | null;
  attempts: number;
  /**
   * The earliest time anyone should look at this note again. Written by the pipeline's
   * failure classifier, and stamped by the client at upload so that `retrySweep`'s
   * range query sees every uploaded note — a Firestore inequality is type-scoped and
   * skips `null` entirely, which would hide exactly the notes ADR-008 is about.
   */
  nextAttemptAt: Timestamp | null;
  /**
   * Server clock, rewritten on every status change. The stale-lock takeover and the
   * sweep's dead-lock query both measure age from here, so it is load-bearing rather
   * than bookkeeping.
   */
  updatedAt: Timestamp;
  error: { code: string; message: string } | null;
}

export interface BookDoc {
  title: string;
  authors: string[];
  chapterTitles: Record<string, string>;
}

export interface ServerHealth {
  ok: boolean; // STT reachable
  llmOk: boolean; // the model list came back — NOT that any of them will answer
  /** The model actually tested: the pinned one, or what auto-pick would choose. */
  llmProbed: string | null;
  /** It answered. The only field that proves cleanup will work — see `probeLlm`. */
  llmUsable: boolean;
  stt: string[];
  llm: string[];
  checkedAt: string;
}

export interface SettingsDoc {
  sttModel: string | null; // null = auto-pick
  llmModel: string | null; // null = auto-pick, 'none' = disable polish
  lastHealth: ServerHealth | null;
}
