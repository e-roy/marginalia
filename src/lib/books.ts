import {
  collection,
  deleteField,
  doc,
  FieldPath,
  increment,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'

import { db } from '@/lib/firebase'
import type { Book } from '@/lib/types'

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
  Pick<Book, 'authors' | 'coverUrl' | 'openLibraryKey' | 'isbn13' | 'status'>
> & { title: string }

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
    Pick<Book, 'title' | 'authors' | 'currentChapter' | 'status' | 'coverUrl' | 'isbn13'>
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
