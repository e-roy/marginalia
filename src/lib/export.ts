import { getDocs, getDocsFromCache } from 'firebase/firestore'

import { booksCollection, toBook } from '@/lib/books'
import { withDeadline } from '@/lib/deadline'
import {
  bookMarkdown,
  exportFilename,
  resolveCollisions,
  type ExportBook,
  type ExportNote,
} from '@/lib/markdown'
import { notesCollection } from '@/lib/notes'
import { noteText, type BookWithId, type Note, type NoteWithId } from '@/lib/types'
import { zipStore } from '@/lib/zip'

/**
 * The adapter between Firestore documents and `markdown.ts`'s plain data (`SPEC §11`).
 *
 * The split is deliberate and load-bearing: everything that touches the SDK lives here,
 * and `markdown.ts` stays importless so `node --experimental-strip-types` can run the
 * renderer against a fixture. Put a `Timestamp` or a `noteText` call on that side and the
 * only test that proves the file format stops being runnable.
 */

/** `charset` spelled out, because these files are full of em dashes and curly quotes. */
export const MARKDOWN_MIME = 'text/markdown;charset=utf-8'

export interface BookExport {
  filename: string
  markdown: string
  /** Notes that made it into the file. */
  written: number
  /** Notes with nothing to write — still in flight, or failed, or silent. */
  skipped: number
}

function toExportBook(book: BookWithId): ExportBook {
  return {
    title: book.title,
    authors: book.authors,
    isbn13: book.isbn13,
    subtitle: book.subtitle,
    publishYear: book.publishYear,
    pageCount: book.pageCount,
    publisher: book.publisher,
    subjects: book.subjects,
  }
}

/**
 * Only notes with text, and the count of the ones dropped.
 *
 * A `queued`, `pending` or `failed` note has no transcript to export, and a `done` note
 * can still be empty when Whisper heard no speech. Writing `Transcribing…` into an
 * Obsidian vault would be a lie that outlives the condition that caused it — so they are
 * left out, and the caller says how many rather than dropping them silently.
 *
 * Chapter titles are resolved here because they live on the *book*, in a map keyed by
 * chapter number as a string (`SPEC §6`) — `markdown.ts` never sees a book's chapter map.
 */
function toExportNotes(book: BookWithId, notes: NoteWithId[]): {
  exported: ExportNote[]
  skipped: number
} {
  const exported: ExportNote[] = []
  let skipped = 0

  for (const note of notes) {
    const text = noteText(note)?.trim() ?? ''
    if (note.status !== 'done' || text.length === 0) {
      skipped += 1
      continue
    }

    exported.push({
      chapter: note.chapter,
      chapterTitle:
        note.chapter === null ? null : (book.chapterTitles?.[String(note.chapter)] ?? null),
      // A client Timestamp, written at record time (`SPEC §6`), so it is never null and
      // never waiting on a server ack — which is exactly why the export can run offline.
      recordedAt: note.recordedAt.toDate(),
      text,
    })
  }

  return { exported, skipped }
}

/** One book as a file, ready to hand to `downloadBlob`. */
export function bookExport(
  book: BookWithId,
  notes: NoteWithId[],
  exportedOn: Date = new Date(),
): BookExport {
  const { exported, skipped } = toExportNotes(book, notes)

  return {
    filename: exportFilename(book.title),
    markdown: bookMarkdown(toExportBook(book), exported, exportedOn),
    written: exported.length,
    skipped,
  }
}

/** Whether there is anything worth exporting, for a button that should say so. */
export function hasExportableNotes(notes: NoteWithId[]): boolean {
  return notes.some((note) => note.status === 'done' && (noteText(note)?.trim().length ?? 0) > 0)
}

export const ZIP_MIME = 'application/zip'

/**
 * How long to wait on the server before exporting whatever this device already holds.
 *
 * `getDocs` has no deadline of its own and waits on the network — the same unbounded wait
 * `deleteBook` guards against, for the third time in this project. What happens *after*
 * the timeout is the opposite of `deleteBook`'s answer, and deliberately so: refusing to
 * delete protects notes that a stale read would strand, while refusing to export protects
 * nothing at all. See ADR-017, which already records both sides of that discriminator.
 *
 * Fifteen rather than ten, because this reads every book and every note rather than one
 * book's, and the cost of being early here is a file the user then has to notice is thin.
 */
const EXPORT_DEADLINE_MS = 15_000

/** Which copy the export was actually built from. `cache` means it may be incomplete. */
export type ExportSource = 'server' | 'cache'

export interface ExportAllResult {
  files: { name: string; text: string }[]
  /** Books written — books whose notes were all still in flight are not among them. */
  books: number
  written: number
  skipped: number
  source: ExportSource
}

/**
 * Everything, as one file per book (`SPEC §11`).
 *
 * **One query for all notes, grouped on the client**, rather than one query per book: a
 * reader has tens of books and a few thousand notes, so this is one round trip instead of
 * fifty, and it is the same reasoning `useBooks` already uses for the shelf.
 *
 * **A cache result is not an error, and that shapes the whole function.** `getDocsFromCache`
 * on a *query* returns whatever the local cache matches — possibly nothing — without
 * rejecting; only the single-document `getDocFromCache` fails on a miss. ADR-017 recorded
 * this project measuring exactly that. So the emptiness check below is on the **result**,
 * not on some error path that will never be taken, and the caller is handed `source` so a
 * file that looks complete can still be labelled as possibly not.
 */
export async function exportAll(
  uid: string,
  exportedOn: Date = new Date(),
): Promise<ExportAllResult> {
  let source: ExportSource = 'server'

  const [bookDocs, noteDocs] = await withDeadline(
    Promise.all([getDocs(booksCollection(uid)), getDocs(notesCollection(uid))]),
    EXPORT_DEADLINE_MS,
    'Timed out reading your notes from the server.',
  ).catch(async (err: unknown) => {
    if ((err as { code?: unknown } | null)?.code !== 'unavailable') throw err
    // The server went quiet rather than absent — offline, `getDocs` would have returned
    // the cache immediately and never reached here.
    source = 'cache'
    return Promise.all([
      getDocsFromCache(booksCollection(uid)),
      getDocsFromCache(notesCollection(uid)),
    ])
  })

  // Through `toBook` for the same reason `useBooks` is: a book written before the metadata
  // fields existed has none of them, and `bookMarkdown` reads `subjects` with `.map`. This
  // is the read the per-book Export button never touches — that one is fed by `useBook`,
  // which is already normalized — so a bare cast here fails only on **Export all**.
  const books = bookDocs.docs.map((entry) => toBook(entry.id, entry.data()))

  const byBook = new Map<string, NoteWithId[]>()
  for (const entry of noteDocs.docs) {
    const note = { id: entry.id, ...(entry.data() as Note) }
    const existing = byBook.get(note.bookId)
    if (existing) existing.push(note)
    else byBook.set(note.bookId, [note])
  }

  const drafts = books
    .map((book) => bookExport(book, byBook.get(book.id) ?? [], exportedOn))
    // A book whose notes are all still transcribing has nothing to say yet, and an
    // Obsidian file containing only frontmatter is worse than no file.
    .filter((draft) => draft.written > 0)

  const names = resolveCollisions(drafts.map((draft) => draft.filename))

  return {
    files: drafts.map((draft, i) => ({ name: names[i] ?? draft.filename, text: draft.markdown })),
    books: drafts.length,
    written: drafts.reduce((sum, draft) => sum + draft.written, 0),
    skipped: drafts.reduce((sum, draft) => sum + draft.skipped, 0),
    source,
  }
}

/** The files as one archive. Store-only — see `zip.ts` for why that is enough. */
export function zipExport(files: { name: string; text: string }[], when: Date): Blob {
  const encoder = new TextEncoder()
  const bytes = zipStore(
    files.map((file) => ({ name: file.name, bytes: encoder.encode(file.text) })),
    when,
  )
  // `Uint8Array` rather than its ArrayBuffer, so a future change to a view over a larger
  // buffer cannot silently include the slack.
  return new Blob([bytes], { type: ZIP_MIME })
}

/** `marginalia-2026-08-24.zip` — sortable, and obvious a year later. */
export function archiveFilename(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `marginalia-${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}.zip`
}
