import type { Timestamp } from 'firebase/firestore'

/**
 * The Firestore data model, client side. Mirrors SPEC §6, and the functions keep their
 * own copy in `functions/src/types.ts` — both describe the same documents and neither
 * is generated from the other, so a change to one is a change to all three.
 */

export type NoteStatus =
  | 'queued' // audio in IndexedDB, not yet uploaded
  | 'pending' // uploaded, waiting on the speech server
  | 'transcribing' // the function is working
  | 'done'
  | 'failed' // gave up after max attempts

export interface Note {
  source: 'voice' | 'text'

  bookId: string
  bookTitle: string // denormalized for the feed
  chapter: number | null // null = Unfiled

  status: NoteStatus
  rawText: string | null // verbatim Whisper output, never overwritten
  cleanText: string | null // the LLM polish; null when it did not run
  title: string | null
  edited: boolean

  durationMs: number | null
  recordedAt: Timestamp // client clock at record time — the real one
  transcribedAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp

  sttModel: string | null
  llmModel: string | null

  audioPath: string | null // nulled when the object is deleted
  attempts: number
  nextAttemptAt: Timestamp | null
  error: { code: string; message: string } | null // sanitized — see SPEC §2

  tags: string[]
  page: number | null
  pinned: boolean
}

/** A note as read back, carrying its document id. */
export type NoteWithId = Note & { id: string }

export interface Book {
  title: string
  authors: string[]
  coverUrl: string | null
  openLibraryKey: string | null
  isbn13: string | null
  status: 'reading' | 'finished' | 'shelved'

  /** Chapter numbers ARE the identity — no chapter documents anywhere. */
  chapterTitles: Record<string, string>
  currentChapter: number | null // per-book resume point; null = Unfiled

  noteCount: number
  lastNoteAt: Timestamp | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** A book as read back, carrying its document id. */
export type BookWithId = Book & { id: string }

export interface ServerHealth {
  ok: boolean // STT reachable
  llmOk: boolean // the model list came back — NOT that any of them will answer
  /** The model actually tested: the pinned one, or what auto-pick would choose. */
  llmProbed: string | null
  /** It answered. The only field that proves cleanup will work. */
  llmUsable: boolean
  stt: string[]
  llm: string[]
  checkedAt: string
}

export interface Settings {
  sttModel: string | null // null = auto-pick
  llmModel: string | null // null = auto-pick, 'none' = disable polish
  lastHealth: ServerHealth | null
}

/** Rendered text for a note: the polish when it exists, the raw transcript until M4. */
export function noteText(note: Note): string | null {
  return note.cleanText ?? note.rawText
}
