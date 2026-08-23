import {
  collection,
  deleteDoc,
  doc,
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
import { forgetNoteOnBook, recordNoteOnBook } from '@/lib/books'
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

/**
 * Delete a note, and whatever of it is still lying around.
 *
 * The device queue is cleared first, because a `queued` note whose document is gone
 * would otherwise still be uploaded on the next flush, fire the trigger, and be
 * discarded server-side — correct, but a pointless round trip on mobile data.
 *
 * Audio already in Storage is not this function's problem and could not be: the
 * Storage rules deny the client `delete` outright. `transcribeNote` deletes any object
 * whose note has vanished, and the bucket lifecycle rule is the backstop behind that.
 */
export async function deleteNote(uid: string, noteId: string, bookId: string): Promise<void> {
  await deleteAudio(noteId)
  await deleteDoc(noteRef(uid, noteId))

  // Not awaited, matching the way the counter is bumped on the way in. It is a display
  // figure on the shelf, and a failure here must never report a completed delete as
  // failed — the note is already gone.
  void forgetNoteOnBook(uid, bookId)
}

/**
 * How long after an upload `retrySweep` should leave a note alone.
 *
 * `transcribeNote` normally fires within seconds of the object landing, and the sweep
 * must not race it. Stamping the field here — rather than leaving it null until the
 * first failure — is what lets the sweep's range query see every uploaded note: a
 * Firestore inequality is type-scoped and skips `null`, so an unstamped note is
 * invisible to `nextAttemptAt <= now` no matter how long it sits there. That is the
 * exact shape of the stranded note ADR-008 was written about.
 *
 * A client clock is good enough. Skew only makes a retry early or late, and both the
 * `done` guard and the `transcribing` lock make a duplicate run harmless.
 *
 * Not the same constant as the sweep's own `UNSTAMPED_AGE_MS`, which decides how old an
 * *unstamped* note must be before the backstop query touches it. They start equal and
 * are free to diverge.
 */
const UPLOAD_GRACE_MS = 5 * 60_000

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
        nextAttemptAt: Timestamp.fromMillis(Date.now() + UPLOAD_GRACE_MS),
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
 * Put a note that gave up back in the queue for `retrySweep` to collect.
 *
 * Only meaningful while the audio still exists. A note that exhausted its six attempts
 * keeps its recording — the server being asleep says nothing about the recording — and
 * the bucket lifecycle rule reclaims it after about a day. A note that failed because
 * the audio itself was rejected has already had those bytes deleted, and the Note
 * screen offers no button for it.
 *
 * A plain client write rather than a callable, deliberately: the client already owns
 * `queued → pending` in `uploadOne`, the security rules already scope writes to the
 * user's own subtree, and adding a network round trip to a server would be a strange
 * dependency for the one action whose whole purpose is recovering from that server
 * being unreliable. Firestore's offline cache means the tap registers even with no
 * signal, and the sweep sees it whenever the write lands.
 */
export async function retryNote(uid: string, noteId: string): Promise<void> {
  await updateDoc(noteRef(uid, noteId), {
    status: 'pending',
    // Back to a clean slate: the sweep bounds itself by `attempts`, so leaving it at
    // six would mean the note was collected and immediately given up on again.
    attempts: 0,
    nextAttemptAt: Timestamp.now(),
    error: null,
    updatedAt: serverTimestamp(),
  })
}

/**
 * Model discovery, plus a real test of the cleanup model. Auth-required and
 * server-side — the browser never contacts the speech server, and no model name is
 * hardcoded anywhere (SPEC §5).
 *
 * The explicit timeout is load-bearing, for the same reason `REPOLISH_TIMEOUT_MS` is.
 * Since M6 this call may spend 15s on discovery and a further 45s proving the cleanup
 * model answers — and the SDK's own default is 70s, which would sit *inside* the
 * function's 120s budget and report a failure for a check that was about to return.
 * Outermost of three: 45s probe, 120s function, 150s here.
 */
const HEALTH_TIMEOUT_MS = 150_000

export async function checkServerHealth(): Promise<ServerHealth> {
  const call = httpsCallable<undefined, ServerHealth>(functions, 'serverHealth', {
    timeout: HEALTH_TIMEOUT_MS,
  })
  const result = await call()
  return result.data
}

/**
 * Re-run the cleanup pipeline on a note's stored `rawText` (SPEC §7). Used for a note
 * captured while Ollama was asleep, and for re-running one through a different model.
 *
 * The explicit timeout is load-bearing. It is the outermost of three nested deadlines —
 * the polish request gives up at 45s and the function at 90s — and the SDK's own
 * default is 70s, which would sit *inside* the function's budget and report a failure
 * for a call that was about to write. The write reaches the screen through `onSnapshot`
 * regardless; this promise only drives a spinner.
 */
const REPOLISH_TIMEOUT_MS = 120_000

export async function repolishNote(noteId: string): Promise<{ llmModel: string }> {
  const call = httpsCallable<{ noteId: string }, { llmModel: string }>(
    functions,
    'repolishNote',
    { timeout: REPOLISH_TIMEOUT_MS },
  )
  const result = await call({ noteId })
  return result.data
}
