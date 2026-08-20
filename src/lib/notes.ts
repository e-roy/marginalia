import {
  collection,
  doc,
  getDoc,
  increment,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  waitForPendingWrites,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { ref, uploadBytesResumable } from 'firebase/storage'

import { deleteAudio, listAudio, putAudio, type QueuedAudio } from '@/lib/audioQueue'
import { db, functions, storage } from '@/lib/firebase'
import type { Recording } from '@/lib/recorder'
import type { Book, ServerHealth } from '@/lib/types'

/**
 * Writing a note, and getting its audio to Storage.
 *
 * The split matters: recording finishes locally and instantly, and everything after it
 * is a background job that the phone is allowed to be absent for.
 */

/**
 * Milestone 2 has no shelf — Open Library search, the recent-books strip, and the real
 * chapter UI are Milestone 3. But a note carries `bookId`, `bookTitle`, and `chapter`,
 * and the Whisper prompt is built from them, so the pipeline can't be exercised without
 * a book. One placeholder document stands in until M3 replaces it.
 */
export const PLACEHOLDER_BOOK_ID = 'placeholder'

export function bookRef(uid: string) {
  return doc(db, `users/${uid}/books/${PLACEHOLDER_BOOK_ID}`)
}

export function noteRef(uid: string, noteId: string) {
  return doc(db, `users/${uid}/notes/${noteId}`)
}

export function notesCollection(uid: string) {
  return collection(db, `users/${uid}/notes`)
}

/** Created once per user. Never overwrites an existing title or chapter. */
export async function ensurePlaceholderBook(uid: string): Promise<void> {
  const existing = await getDoc(bookRef(uid))
  if (existing.exists()) return

  const book: Omit<Book, 'createdAt' | 'updatedAt' | 'lastNoteAt'> = {
    title: 'Untitled book',
    authors: [],
    coverUrl: null,
    openLibraryKey: null,
    isbn13: null,
    status: 'reading',
    chapterTitles: {},
    currentChapter: 1,
    noteCount: 0,
  }

  await setDoc(bookRef(uid), {
    ...book,
    lastNoteAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}

export function updateBook(
  uid: string,
  fields: Partial<Pick<Book, 'title' | 'authors' | 'currentChapter'>>,
): Promise<void> {
  return updateDoc(bookRef(uid), { ...fields, updatedAt: serverTimestamp() })
}

/**
 * Record → note document → IndexedDB, and the UI is finished. Nothing here waits on
 * the network: the Firestore write goes through the offline cache, and the audio is
 * held on the device until `flushQueue` can get it to Storage.
 */
export async function createVoiceNote(
  uid: string,
  recording: Recording,
  book: { id: string; title: string; chapter: number | null },
): Promise<string> {
  const noteId = doc(notesCollection(uid)).id

  // Audio first. If the tab dies between here and the Firestore write, the orphan is
  // recoverable; the reverse would be a note that can never be transcribed.
  await putAudio({
    noteId,
    uid,
    blob: recording.blob,
    mime: recording.format.mime,
    ext: recording.format.ext,
    queuedAt: Date.now(),
  })

  // Deliberately not awaited: offline, this resolves only once the server acks, and
  // the point of the queue is that capture never blocks on the network. The local
  // cache updates synchronously, so the note is on screen immediately either way.
  void setDoc(noteRef(uid, noteId), {
    source: 'voice',
    bookId: book.id,
    bookTitle: book.title,
    chapter: book.chapter,
    status: 'queued',
    rawText: null,
    cleanText: null,
    title: null,
    edited: false,
    durationMs: recording.durationMs,
    recordedAt: Timestamp.fromDate(recording.recordedAt),
    transcribedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    sttModel: null,
    llmModel: null,
    audioPath: null,
    attempts: 0,
    nextAttemptAt: null,
    error: null,
    tags: [],
    page: null,
    pinned: false,
  })

  void updateDoc(bookRef(uid), {
    noteCount: increment(1),
    lastNoteAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  return noteId
}

async function uploadOne(entry: QueuedAudio): Promise<void> {
  // `transcribeNote` fires on the object and then looks for the note document. If the
  // audio landed first, the function would find nothing to attach a transcript to and
  // discard the recording — so the note write has to be acknowledged by the server
  // before any bytes go up. Firestore applies writes in order, so this covers it.
  await waitForPendingWrites(db)

  const objectRef = ref(storage, `users/${entry.uid}/uploads/${entry.noteId}`)
  await uploadBytesResumable(objectRef, entry.blob, {
    contentType: entry.mime,
    // The function prefers this over sniffing the content type, because Whisper reads
    // the container from the filename it is given.
    customMetadata: { ext: entry.ext },
  })

  // The device's copy has done its job the moment Storage has the bytes.
  await deleteAudio(entry.noteId)

  // Conditional, because the trigger may already have moved this note on to
  // `transcribing` or even `done` while the upload was finishing. Overwriting that
  // with `pending` would be a plain lie about where the note is.
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(noteRef(entry.uid, entry.noteId))
    if (snap.exists() && snap.get('status') === 'queued') {
      tx.update(noteRef(entry.uid, entry.noteId), {
        status: 'pending',
        updatedAt: serverTimestamp(),
      })
    }
  })
}

let flushing = false

/**
 * Drain the device queue, oldest first.
 *
 * There is no Background Sync on iOS, so this is called from every plausible trigger
 * instead — app launch, `visibilitychange` → visible, and `online` (SPEC §4). Uploads
 * run one at a time so a backlog on mobile data doesn't contend with itself.
 */
export async function flushQueue(uid: string): Promise<{ uploaded: number; failed: number }> {
  if (flushing || navigator.onLine === false) return { uploaded: 0, failed: 0 }
  flushing = true

  let uploaded = 0
  let failed = 0
  try {
    for (const entry of await listAudio(uid)) {
      try {
        await uploadOne(entry)
        uploaded += 1
      } catch (err) {
        // Left in the queue for the next trigger. An upload needs the internet, not
        // the speech server, so this is almost always a signal problem.
        failed += 1
        console.warn('[marginalia] upload failed, staying queued', entry.noteId, err)
      }
    }
  } finally {
    flushing = false
  }
  return { uploaded, failed }
}

/**
 * Model discovery. Auth-required and server-side — the browser never contacts the
 * speech server, and no model name is hardcoded anywhere (SPEC §5).
 */
export async function checkServerHealth(): Promise<ServerHealth> {
  const call = httpsCallable<undefined, ServerHealth>(functions, 'serverHealth')
  const result = await call()
  return result.data
}
