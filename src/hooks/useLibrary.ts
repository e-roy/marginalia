import { limit, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { useEffect, useMemo, useState } from 'react'

import { booksCollection } from '@/lib/books'
import { noteRef, notesCollection } from '@/lib/notes'
import { settingsRef } from '@/lib/settings'
import type { Book, BookWithId, Note, NoteWithId, Settings } from '@/lib/types'

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
 * Every note that gave up, live.
 *
 * Deliberately its own subscription rather than a filter over `useLiveNotes`. That feed
 * is capped at the newest 50, which is right for it — anything still in flight is by
 * definition recent — and wrong here: a note that gave up is precisely the one you come
 * back to days later, and it would drop silently out of the count once fifty newer notes
 * existed. A count that quietly stops counting is worse than no count.
 *
 * No `limit`, and that is a decision rather than an omission: a truncated count of
 * failures is meaningless, and if this ever returns enough documents to matter then the
 * resilience it reports is what has failed, not the query. Firestore serves the single
 * equality filter from its automatic index, so there is no composite index behind this.
 */
export function useFailedNotes(uid: string | null): NoteWithId[] {
  const [failed, setFailed] = useState<NoteWithId[]>([])

  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      query(notesCollection(uid), where('status', '==', 'failed')),
      (snapshot) => {
        setFailed(snapshot.docs.map((entry) => ({ id: entry.id, ...(entry.data() as Note) })))
      },
      (err) => console.error('[marginalia] failed-notes subscription failed', err),
    )
  }, [uid])

  return uid ? failed : []
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

/**
 * One note, live. The Note screen needs this rather than picking out of the feed,
 * because the feed is capped at the newest 50 and a note is reachable by URL forever.
 *
 * `loading` is separate from a null note on purpose: "we have not heard yet" and "there
 * is no such note" look identical otherwise, and the difference decides between showing
 * a blank screen for a moment and redirecting away from a note that is about to arrive.
 */
export function useNote(
  uid: string | null,
  noteId: string | null,
): { note: NoteWithId | null; loading: boolean } {
  const [loaded, setLoaded] = useState<{ noteId: string; note: NoteWithId | null } | null>(null)

  useEffect(() => {
    if (!uid || !noteId) return
    return onSnapshot(
      noteRef(uid, noteId),
      (snapshot) => {
        setLoaded({
          noteId,
          note: snapshot.exists()
            ? { id: snapshot.id, ...(snapshot.data() as Note) }
            : null,
        })
      },
      (err) => console.error('[marginalia] note subscription failed', err),
    )
  }, [uid, noteId])

  // Keyed by the note it came from, so switching notes never shows the previous one's
  // text under the new one's id — the same trap `useBookNotes` above avoids.
  return useMemo(() => {
    const current = loaded && loaded.noteId === noteId ? loaded : null
    return { note: current?.note ?? null, loading: current === null }
  }, [loaded, noteId])
}

/**
 * The settings document, live. Null until it exists — which is normal, because nothing
 * creates it until the first server check or the first pinned model.
 *
 * Live rather than fetched once because `lastHealth` is written by the `serverHealth`
 * function, not by the client: the model lists appear in the pickers on their own when
 * a check comes back.
 */
export function useSettings(uid: string | null): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      settingsRef(uid),
      (snapshot) => setSettings(snapshot.exists() ? (snapshot.data() as Settings) : null),
      (err) => console.error('[marginalia] settings subscription failed', err),
    )
  }, [uid])

  return uid ? settings : null
}
