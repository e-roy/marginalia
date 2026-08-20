import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  waitForPendingWrites,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { ref, uploadBytesResumable } from 'firebase/storage'

import { deleteAudio, listAudio, putAudio, type QueuedAudio } from '@/lib/audioQueue'
import { recordNoteOnBook } from '@/lib/books'
import { db, functions, storage } from '@/lib/firebase'
import type { Recording } from '@/lib/recorder'
import type { ServerHealth } from '@/lib/types'

/**
 * Writing a note, and getting its audio to Storage.
 *
 * The split matters: recording finishes locally and instantly, and everything after it
 * is a background job that the phone is allowed to be absent for.
 */

/** Which book and chapter a note is filed under, as the capture UI knows it. */
export interface NoteTarget {
  id: string
  title: string
  chapter: number | null
}

export function noteRef(uid: string, noteId: string) {
  return doc(db, `users/${uid}/notes/${noteId}`)
}

export function notesCollection(uid: string) {
  return collection(db, `users/${uid}/notes`)
}

/**
 * Every field of a note that neither kind sets differently. Spelled out rather than
 * partially written, because a note document is read by the function and by the feed,
 * and a missing field reads as `undefined` in both.
 */
function blankNote(book: NoteTarget) {
  return {
    bookId: book.id,
    bookTitle: book.title,
    chapter: book.chapter,
    rawText: null,
    cleanText: null,
    title: null,
    edited: false,
    durationMs: null,
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
  }
}

/**
 * Record → note document → IndexedDB, and the UI is finished. Nothing here waits on
 * the network: the Firestore write goes through the offline cache, and the audio is
 * held on the device until `flushQueue` can get it to Storage.
 */
export async function createVoiceNote(
  uid: string,
  recording: Recording,
  book: NoteTarget,
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
    ...blankNote(book),
    source: 'voice',
    status: 'queued',
    durationMs: recording.durationMs,
    recordedAt: Timestamp.fromDate(recording.recordedAt),
  })

  void recordNoteOnBook(uid, book.id)

  return noteId
}

/**
 * A typed note never touches Storage, the function, or the pipeline — it is born
 * `done`, with the same string in `rawText` and `cleanText`. If you typed it, you
 * meant it (SPEC §6).
 */
export function createTextNote(uid: string, text: string, book: NoteTarget): string {
  const noteId = doc(notesCollection(uid)).id
  const body = text.trim()

  void setDoc(noteRef(uid, noteId), {
    ...blankNote(book),
    source: 'text',
    status: 'done',
    rawText: body,
    cleanText: body,
    // Client clock, exactly as for a recording, so the feed can order and label it
    // before any server has acknowledged it.
    recordedAt: Timestamp.now(),
    transcribedAt: Timestamp.now(),
  })

  void recordNoteOnBook(uid, book.id)

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
