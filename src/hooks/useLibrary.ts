import { limit, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { useEffect, useMemo, useState } from 'react'

import { booksCollection } from '@/lib/books'
import { notesCollection } from '@/lib/notes'
import type { Book, BookWithId, Note, NoteWithId } from '@/lib/types'

/**
 * Live subscriptions. These are the reason the app never blocks on the network: a note
 * appears the instant it is written to the local cache and fills in later, on its own,
 * when the function has something to say (SPEC §4).
 */

const FEED_LIMIT = 50

export function useLiveNotes(uid: string | null): NoteWithId[] {
  const [notes, setNotes] = useState<NoteWithId[]>([])

  useEffect(() => {
    if (!uid) return
    // `recordedAt` is a client Timestamp, not a server one, so ordering is correct
    // offline too — a serverTimestamp reads back null until it is acked.
    const feed = query(notesCollection(uid), orderBy('recordedAt', 'desc'), limit(FEED_LIMIT))

    return onSnapshot(
      feed,
      (snapshot) => {
        setNotes(snapshot.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Note) })))
      },
      (err) => console.error('[marginalia] notes subscription failed', err),
    )
  }, [uid])

  // Derived rather than cleared from inside the effect: signed out means no notes, and
  // saying so here avoids a setState that would force a second render every time.
  return uid ? notes : []
}

/**
 * Every book, in one subscription, sorted on the client.
 *
 * A reader has tens of books — the whole shelf is a few kilobytes, and holding it in
 * memory means the recent-books strip, the shelf and the chapter stepper all read from
 * one snapshot rather than three queries. It also sidesteps `orderBy('lastNoteAt')`,
 * which sorts nulls last on a descending order and would therefore hide a book you had
 * just added and not yet recorded against.
 */
export function useBooks(uid: string | null): BookWithId[] {
  const [books, setBooks] = useState<BookWithId[]>([])

  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      booksCollection(uid),
      (snapshot) => {
        setBooks(snapshot.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Book) })))
      },
      (err) => console.error('[marginalia] books subscription failed', err),
    )
  }, [uid])

  // Most recently used first: a book with no notes yet falls back to when it was added,
  // and a document still waiting on its server timestamps counts as right now.
  return useMemo(() => {
    if (!uid) return []
    const touchedAt = (book: BookWithId) =>
      book.lastNoteAt?.toMillis() ?? book.createdAt?.toMillis() ?? Number.MAX_SAFE_INTEGER
    return [...books].sort((a, b) => touchedAt(b) - touchedAt(a))
  }, [uid, books])
}

export function useBook(books: BookWithId[], bookId: string | null): BookWithId | null {
  return useMemo(
    () => (bookId === null ? null : (books.find((book) => book.id === bookId) ?? null)),
    [books, bookId],
  )
}

/**
 * One book's notes, oldest first within each chapter — the reading order, not the
 * capture order. Backed by the `bookId, chapter, recordedAt` composite index.
 */
export function useBookNotes(uid: string | null, bookId: string | null): NoteWithId[] {
  /**
   * The snapshot is stored with the book it came from. Switching books would otherwise
   * keep the previous book's notes on screen until the new subscription delivered —
   * briefly, but showing the wrong book's notes under the right book's title.
   */
  const [loaded, setLoaded] = useState<{ bookId: string; notes: NoteWithId[] } | null>(null)

  useEffect(() => {
    if (!uid || !bookId) return
    const forBook = query(
      notesCollection(uid),
      where('bookId', '==', bookId),
      orderBy('chapter', 'asc'),
      orderBy('recordedAt', 'asc'),
    )

    return onSnapshot(
      forBook,
      (snapshot) => {
        setLoaded({
          bookId,
          notes: snapshot.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Note) })),
        })
      },
      (err) => console.error('[marginalia] book notes subscription failed', err),
    )
  }, [uid, bookId])

  return loaded && loaded.bookId === bookId ? loaded.notes : []
}
