import {
  collection,
  deleteField,
  doc,
  FieldPath,
  getDocsFromServer,
  increment,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  waitForPendingWrites,
  where,
  writeBatch,
} from 'firebase/firestore'

import { deleteAudio } from '@/lib/audioQueue'
import { withDeadline } from '@/lib/deadline'
import { db } from '@/lib/firebase'
import type { Book, BookWithId } from '@/lib/types'

/**
 * The shelf (SPEC §6, §9).
 *
 * Chapter numbers are the identity — there are no chapter documents, so "creating" a
 * chapter is not a thing that happens. A chapter exists the moment a note references
 * it, and a title is an optional entry in a map on the book.
 */

export function booksCollection(uid: string) {
  return collection(db, `users/${uid}/books`)
}

export function bookRef(uid: string, bookId: string) {
  return doc(db, `users/${uid}/books/${bookId}`)
}

/** What any of the three add-a-book paths supplies. Everything else has a default. */
export type NewBook = Partial<
  Pick<
    Book,
    | 'authors'
    | 'coverUrl'
    | 'openLibraryKey'
    | 'isbn13'
    | 'status'
    | 'subtitle'
    | 'publishYear'
    | 'pageCount'
    | 'publisher'
    | 'subjects'
    | 'subjectPeople'
    | 'description'
    | 'tableOfContents'
  >
> & { title: string }

/**
 * The one place a Firestore book document becomes a `Book`.
 *
 * **A document is whatever was written to it, not whatever the interface says.** Every book
 * created before 2026-08-24 predates `subtitle`, `publishYear`, `pageCount`, `publisher` and
 * `subjects`, so those fields are `undefined` on the wire while `Book` types them
 * `string | null` and `string[]`. `subjects` is the dangerous one — `undefined.map()` is a
 * crash, and the shelf renders every book.
 *
 * Both raw reads go through here: `useBooks` in `@/hooks/useLibrary` and `exportAll` in
 * `@/lib/export`. Those were the only two `as Book` casts in the client, and the export one
 * is the easy one to miss — the per-book export button is fed by `useBook`, so a regression
 * there would look fine on the Book screen and only surface on **Export all**.
 *
 * `chapterTitles` is defaulted for the same reason: `export.ts` already reached for it with
 * an optional chain, which was this hazard met once and patched at one site instead of at
 * the boundary.
 *
 * The functions side is deliberately out of reach here — `pipeline.ts` reads the document
 * with its own cast and stays defensive with `book?.field`.
 */
export function toBook(id: string, data: unknown): BookWithId {
  const raw = data as Partial<Book>

  return {
    ...(raw as Book),
    id,
    chapterTitles: raw.chapterTitles ?? {},
    subtitle: raw.subtitle ?? null,
    publishYear: raw.publishYear ?? null,
    pageCount: raw.pageCount ?? null,
    publisher: raw.publisher ?? null,
    subjects: raw.subjects ?? [],
    subjectPeople: raw.subjectPeople ?? [],
    description: raw.description ?? null,
    tableOfContents: raw.tableOfContents ?? [],
  }
}

/**
 * Returns the new book's id so the caller can select it immediately — adding a book is
 * always in service of writing a note about it.
 */
export async function createBook(uid: string, input: NewBook): Promise<string> {
  const bookId = doc(booksCollection(uid)).id

  const book: Omit<Book, 'createdAt' | 'updatedAt' | 'lastNoteAt'> = {
    title: input.title.trim() || 'Untitled book',
    authors: input.authors ?? [],
    coverUrl: input.coverUrl ?? null,
    openLibraryKey: input.openLibraryKey ?? null,
    isbn13: input.isbn13 ?? null,
    status: input.status ?? 'reading',
    subtitle: input.subtitle ?? null,
    publishYear: input.publishYear ?? null,
    pageCount: input.pageCount ?? null,
    publisher: input.publisher ?? null,
    subjects: input.subjects ?? [],
    subjectPeople: input.subjectPeople ?? [],
    description: input.description ?? null,
    tableOfContents: input.tableOfContents ?? [],
    chapterTitles: {},
    currentChapter: 1,
    noteCount: 0,
  }

  // Not awaited on the caller's behalf: like every write in this app it goes through
  // the offline cache first, so the book is on screen before the server hears about it.
  void setDoc(bookRef(uid, bookId), {
    ...book,
    lastNoteAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  return bookId
}

export function updateBook(
  uid: string,
  bookId: string,
  fields: Partial<
    Pick<
      Book,
      | 'title'
      | 'authors'
      | 'currentChapter'
      | 'status'
      | 'coverUrl'
      | 'isbn13'
      // Metadata is frequently wrong and stays editable forever (`SPEC §9`) — which for
      // these five matters more than usual, since Open Library is the only thing that ever
      // fills them and a book added by hand starts with all five blank.
      | 'subtitle'
      | 'publishYear'
      | 'pageCount'
      | 'publisher'
      | 'subjects'
      | 'subjectPeople'
      | 'description'
      | 'tableOfContents'
    >
  >,
): Promise<void> {
  return updateDoc(bookRef(uid, bookId), { ...fields, updatedAt: serverTimestamp() })
}

/**
 * Set or clear one chapter's title.
 *
 * `FieldPath` rather than a dotted string, because a numeric segment like
 * `chapterTitles.12` is not a field path the string parser will take — and chapter keys
 * are always numeric.
 */
export function setChapterTitle(
  uid: string,
  bookId: string,
  chapter: number,
  title: string,
): Promise<void> {
  const trimmed = title.trim()
  return updateDoc(
    bookRef(uid, bookId),
    new FieldPath('chapterTitles', String(chapter)),
    trimmed.length > 0 ? trimmed : deleteField(),
    'updatedAt',
    serverTimestamp(),
  )
}

/**
 * Bump the counters a new note implies. `lastNoteAt` is what orders the recent-books
 * strip, so this is also what makes a book "current" again after switching away.
 */
export function recordNoteOnBook(uid: string, bookId: string): Promise<void> {
  return updateDoc(bookRef(uid, bookId), {
    noteCount: increment(1),
    lastNoteAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}

/**
 * The book's notes, built here rather than imported from `@/lib/notes`.
 *
 * That module already imports this one, for `recordNoteOnBook` / `forgetNoteOnBook`, so
 * the dependency runs notes → books. Importing `notesCollection` back would close the
 * loop; today's bundler tolerates it because every use is inside a function body, which
 * is exactly the kind of thing that stops being true during a refactor. One duplicated
 * path literal is the cheaper of the two.
 */
function notesOfUser(uid: string) {
  return collection(db, `users/${uid}/notes`)
}

/** Firestore commits at most 500 operations per batch; the book document is one of them. */
const BATCH_LIMIT = 450

/**
 * How long to wait for the server before calling a book undeletable.
 *
 * `getDocsFromServer` has no deadline of its own, and it does **not** reject promptly
 * when the server goes away. On a cold instance it fails fast, but once a session is
 * established the SDK treats a refused connection as transient and retries with backoff —
 * observed hanging indefinitely against a stopped emulator, with the dialog spinning and
 * its Escape key deliberately disabled. That is precisely the `search.json` hang M5 fixed
 * on the Open Library side, and the fix is the same one: an explicit deadline, so the
 * failure is a message you can act on rather than a spinner you cannot leave.
 *
 * Ten seconds is far longer than a single book's notes need over mobile data, and short
 * enough that nobody waits on it twice.
 *
 * The helper itself lives in `@/lib/deadline` since M7, because the export path needs the
 * same guard around a read that also has no bound of its own. Note that the two take
 * opposite lines on what a timeout *means*: here it refuses, because deleting on a stale
 * read strands notes; there it falls back to the cache, because a read-only export cannot
 * damage anything.
 */
const READ_DEADLINE_MS = 10_000

/**
 * Delete a book and every note filed under it (`SPEC §8`).
 *
 * **It reads the server — not the screen, and not the cache.** The Book screen's
 * subscription cannot tell "this book has no notes" from "its notes have not arrived
 * yet" (`useBookNotes` has no `loading` flag). Plain `getDocs` is worse: Firestore runs
 * with `persistentLocalCache`, so offline it would cheerfully report zero notes for a
 * book whose notes this device never fetched, and the cascade would delete the book alone
 * and strand them server-side with nothing pointing at them. `getDocsFromServer` fails
 * instead, and no connection meaning no delete is the honest trade — capture is what this
 * app makes offline-first (ADR-001); deleting a book is deliberate management.
 *
 * `waitForPendingWrites` comes first because a server-source query cannot see a local
 * write the server has not acknowledged, and both note constructors write unawaited. It
 * is the same ordering hazard `uploadOne` guards against, for the same reason.
 *
 * Both are under `READ_DEADLINE_MS`, because neither has a deadline of its own and both
 * wait on the network — see that constant for what "fails instead" actually costs when
 * the server merely goes quiet rather than refusing outright.
 *
 * **The book document goes last.** A chunk failing partway then leaves the book with
 * fewer notes — visible, and recoverable by tapping delete again. Deleting the book first
 * would leave notes that nothing can reach, since its screen is the only route to them.
 *
 * Audio already in Storage is untouched, and could not be otherwise: the Storage rules
 * deny the client `delete` outright. `transcribeNote` removes any object whose note has
 * vanished and the bucket lifecycle rule is the backstop — exactly what `deleteNote`
 * already relies on.
 *
 * `onCommitting` fires once the read has succeeded and the deletes are certain to go
 * ahead, before any of them lands. It exists for the caller's navigation: the first batch
 * hits the local cache the moment it is written, so a screen that waits for `commit()`
 * sees its own book vanish underneath it while this is still resolving — the race
 * `Note.tsx` documents for `deleteNote`. Everything above this callback can still fail
 * without anything having been deleted, which is why the callback is here and not at the
 * top.
 */
export async function deleteBook(
  uid: string,
  bookId: string,
  onCommitting?: () => void,
): Promise<void> {
  // Both under the one deadline. `waitForPendingWrites` is the other call here that can
  // wait on the network indefinitely — it resolves only once the server acks — so a
  // deadline on the read alone would just move the hang one line up.
  const notes = await withDeadline(
    (async () => {
      await waitForPendingWrites(db)
      return getDocsFromServer(query(notesOfUser(uid), where('bookId', '==', bookId)))
    })(),
    READ_DEADLINE_MS,
    'Timed out reading the book’s notes from the server.',
  )

  onCommitting?.()

  // Best-effort, and deliberately not fatal — `deleteNote` lets this throw, which is fine
  // when one bad entry blocks one note and re-tapping is the fix. Here a single stuck
  // IndexedDB row would make the book permanently undeletable. Skipping one costs a stale
  // queue entry that gets uploaded once and discarded server-side, which is not a loss.
  for (const note of notes.docs) {
    try {
      await deleteAudio(note.id)
    } catch (err) {
      console.warn('[marginalia] could not clear queued audio', note.id, err)
    }
  }

  // Sequential commits, so the chunk carrying the book is genuinely the last to land.
  const targets = [...notes.docs.map((note) => note.ref), bookRef(uid, bookId)]
  for (let start = 0; start < targets.length; start += BATCH_LIMIT) {
    const batch = writeBatch(db)
    for (const target of targets.slice(start, start + BATCH_LIMIT)) batch.delete(target)
    await batch.commit()
  }
}

/**
 * The other half, for a deleted note.
 *
 * `lastNoteAt` is deliberately left where it is. It orders the recent-books strip by
 * when you last *touched* a book, and recording a note then deleting it is still
 * having touched it — so the stale value is the honest one. Correcting it would mean
 * querying for the new newest note to adjust a tile's position in a five-tile strip.
 */
export function forgetNoteOnBook(uid: string, bookId: string): Promise<void> {
  return updateDoc(bookRef(uid, bookId), {
    noteCount: increment(-1),
    updatedAt: serverTimestamp(),
  })
}
