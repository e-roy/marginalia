import { limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { useEffect, useState } from 'react'

import { bookRef, notesCollection } from '@/lib/notes'
import type { Book, Note, NoteWithId } from '@/lib/types'

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

export function useBook(uid: string | null): Book | null {
  const [book, setBook] = useState<Book | null>(null)

  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      bookRef(uid),
      (snapshot) => setBook(snapshot.exists() ? (snapshot.data() as Book) : null),
      (err) => console.error('[marginalia] book subscription failed', err),
    )
  }, [uid])

  return uid ? book : null
}
