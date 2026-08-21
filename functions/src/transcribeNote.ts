import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as logger from 'firebase-functions/logger';
import { onObjectFinalized } from 'firebase-functions/v2/storage';

import { runCleanup } from './cleanup';
import { REGION, SPEECH_API_KEY, SPEECH_BASE_URL, storageBucket } from './config';
import { SpeechError, toClientError, toLogDetail, type SpeechErrorCode } from './errors';
import { buildPrompt } from './prompt';
import { listSttModels, pickSttModel, transcribe, type SpeechConfig } from './speech';
import type { BookDoc, NoteDoc, SettingsDoc } from './types';

/** Mirrors the Storage rule. The Admin SDK bypasses rules, so it re-checks for itself. */
const MAX_BYTES = 25 * 1024 * 1024;

/** SPEC §4: the retry sweep picks up notes with `attempts < 6`. */
const MAX_ATTEMPTS = 6;

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/**
 * A run that dies mid-flight leaves the note locked as `transcribing`, and a redelivery
 * would otherwise skip it forever. This function's own timeout is 300s, so nothing
 * older than this can still be running — the lock is safe to take over.
 */
const STALE_LOCK_MS = 10 * 60_000;

/** Only the client uploads here, and only in this shape. */
const UPLOAD_PATH = /^users\/([^/]+)\/uploads\/([^/]+)$/;

/**
 * Whisper sniffs the container from the filename, so the extension has to match what
 * was actually recorded. Safari gives `audio/mp4` (AAC) and everything else gives
 * webm — see SPEC §12.
 */
const EXTENSIONS: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/** Retrying these produces the identical failure, so they end the note immediately. */
const TERMINAL_CODES: ReadonlySet<SpeechErrorCode> = new Set<SpeechErrorCode>([
  'stt_rejected',
  'no_stt_model',
  'audio_missing',
  'audio_too_large',
]);

function extensionFor(contentType: string | undefined, declared: string | undefined): string {
  if (declared && /^[a-z0-9]{2,5}$/i.test(declared)) return declared.toLowerCase();
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSIONS[base] ?? 'm4a';
}

/**
 * Audio is transient at every hop and deleted the moment it is no longer needed. A
 * failed delete is logged but never fails the note — the bucket lifecycle rule is the
 * backstop that makes "audio is never kept" true rather than merely intended.
 */
async function discardAudio(bucket: string, name: string): Promise<void> {
  try {
    await getStorage().bucket(bucket).file(name).delete({ ignoreNotFound: true });
  } catch (err) {
    logger.error('transcribeNote: failed to delete audio', { name, detail: toLogDetail(err) });
  }
}

/**
 * The whole pipeline. Fires on upload, transcribes (Stage 1), cleans up (Stages 2 and
 * 3 via `runCleanup`), writes both texts back, and deletes the object.
 *
 * `rawText` is stored verbatim and never overwritten; `cleanText` is what the UI
 * shows. Note that `runCleanup` cannot throw an LLM error — see `cleanup.ts` — so an
 * Ollama outage never reaches the failure classifier below and can never cost a note
 * its transcript.
 */
export const transcribeNote = onObjectFinalized(
  {
    region: REGION,
    bucket: storageBucket(),
    secrets: [SPEECH_BASE_URL, SPEECH_API_KEY],
    // Must comfortably exceed the 95s transcription budget in `speech.ts`.
    timeoutSeconds: 300,
    memory: '512MiB',
    /**
     * Retry on crash, deliberately.
     *
     * There are two kinds of failure here and they need different owners. An
     * *application* failure — the server is down, the audio is junk — is caught below,
     * recorded on the note, and rescheduled by `attempts`/`nextAttemptAt`; the handler
     * returns normally, so Eventarc sees a success and never redelivers. A *crash* is
     * the other kind: the runtime dies before anything is written, so no attempt is
     * recorded and nothing in our own bookkeeping knows the note exists to retry.
     *
     * That second case is not hypothetical. Seen 2026-08-20: the emulator's functions
     * runtime overran its startup deadline, the event was dropped, and a real recording
     * sat in `pending` with `attempts: 0` indefinitely — indistinguishable, in the UI,
     * from a note that was still working. Redelivery is the only thing that can see it.
     */
    retry: true,
  },
  async (event) => {
    const objectName = event.data.name;
    const match = objectName ? UPLOAD_PATH.exec(objectName) : null;
    const uid = match?.[1];
    const noteId = match?.[2];
    if (!objectName || !uid || !noteId) return; // Not an audio upload — nothing to do.

    const bucket = event.data.bucket;
    const db = getFirestore();
    const noteRef = db.doc(`users/${uid}/notes/${noteId}`);
    const snap = await noteRef.get();

    if (!snap.exists) {
      // No note to attach a transcript to. The bytes have no reason to exist.
      logger.warn('transcribeNote: no note document', { uid, noteId });
      await discardAudio(bucket, objectName);
      return;
    }

    const note = snap.data() as NoteDoc;

    // onObjectFinalized can deliver more than once. Without this guard a duplicate
    // delivery re-transcribes a finished note and burns GPU time on an answer we have.
    if (note.status === 'done') {
      logger.info('transcribeNote: already transcribed', { uid, noteId });
      return;
    }

    if (note.status === 'transcribing') {
      const updatedAt = snap.get('updatedAt') as Timestamp | null;
      const lockAgeMs = updatedAt ? Date.now() - updatedAt.toMillis() : Number.POSITIVE_INFINITY;

      if (lockAgeMs < STALE_LOCK_MS) {
        logger.info('transcribeNote: already in flight', { uid, noteId, lockAgeMs });
        return;
      }
      // Older than any run could possibly be, so the previous attempt died. Skipping
      // here instead would strand the note permanently.
      logger.warn('transcribeNote: taking over a stale lock', { uid, noteId, lockAgeMs });
    }

    const attempts = (note.attempts ?? 0) + 1;
    await noteRef.update({
      status: 'transcribing',
      attempts,
      audioPath: objectName,
      updatedAt: FieldValue.serverTimestamp(),
    });

    try {
      const size = Number(event.data.size ?? 0);
      if (size > MAX_BYTES) {
        throw new SpeechError('audio_too_large', `${size} bytes exceeds ${MAX_BYTES}`);
      }

      const cfg: SpeechConfig = {
        baseUrl: SPEECH_BASE_URL.value(),
        apiKey: SPEECH_API_KEY.value(),
      };

      // Settings and the book are two reads that only exist to make the transcript
      // better; both are allowed to be absent.
      const [settingsSnap, bookSnap] = await Promise.all([
        db.doc(`users/${uid}/settings/app`).get(),
        note.bookId ? db.doc(`users/${uid}/books/${note.bookId}`).get() : Promise.resolve(null),
      ]);

      const settings = settingsSnap.exists ? (settingsSnap.data() as SettingsDoc) : null;
      const book = bookSnap?.exists ? (bookSnap.data() as BookDoc) : null;

      let model = settings?.sttModel ?? null;
      if (!model) {
        // Nothing pinned — discover, and auto-pick per SPEC §5.
        model = pickSttModel(await listSttModels(cfg));
        if (!model) throw new SpeechError('no_stt_model', 'no id matched /whisper/i');
      }

      const file = getStorage().bucket(bucket).file(objectName);
      let audio: Buffer;
      try {
        [audio] = await file.download();
      } catch (err) {
        throw new SpeechError('audio_missing', toLogDetail(err));
      }

      const rawText = await transcribe(cfg, {
        audio,
        filename: `${noteId}.${extensionFor(event.data.contentType, event.data.metadata?.ext)}`,
        contentType: event.data.contentType ?? 'audio/mp4',
        model,
        prompt: buildPrompt(note.bookTitle, book, note.chapter),
      });

      // Stages 2 and 3. Best-effort by construction: at worst this returns the filler
      // strip with `llmModel: null`, which the Note screen reads as "offer a re-polish".
      const cleanup = await runCleanup(cfg, rawText, settings);

      await noteRef.update({
        status: 'done',
        rawText,
        cleanText: cleanup.cleanText,
        title: cleanup.title,
        llmModel: cleanup.llmModel,
        sttModel: model,
        transcribedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        audioPath: null,
        error: null,
        nextAttemptAt: null,
      });

      // The transcript has committed. The audio has served its only purpose.
      await discardAudio(bucket, objectName);
      logger.info('transcribeNote: done', {
        uid,
        noteId,
        model,
        llmModel: cleanup.llmModel,
        rawChars: rawText.length,
        cleanChars: cleanup.cleanText.length,
      });
    } catch (err) {
      const clientError = toClientError(err);
      const terminal = TERMINAL_CODES.has(clientError.code) || attempts >= MAX_ATTEMPTS;

      logger.error('transcribeNote: failed', {
        uid,
        noteId,
        attempts,
        terminal,
        detail: toLogDetail(err),
      });

      await noteRef.update({
        // `failed` means "gave up". Anything retryable goes back to `pending` for the
        // sweep to pick up (M6) — the note keeps its audio until then.
        status: terminal ? 'failed' : 'pending',
        error: clientError,
        audioPath: terminal ? null : objectName,
        nextAttemptAt: terminal
          ? null
          : Timestamp.fromMillis(
              Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS),
            ),
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (terminal) await discardAudio(bucket, objectName);
    }
  },
);
