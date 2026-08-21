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
  error: { code: string; message: string } | null;
}

export interface BookDoc {
  title: string;
  authors: string[];
  chapterTitles: Record<string, string>;
}

export interface ServerHealth {
  ok: boolean; // STT reachable
  llmOk: boolean; // false if Ollama 502s — it fails independently
  stt: string[];
  llm: string[];
  checkedAt: string;
}

export interface SettingsDoc {
  sttModel: string | null; // null = auto-pick
  llmModel: string | null; // null = auto-pick, 'none' = disable polish
  lastHealth: ServerHealth | null;
}
