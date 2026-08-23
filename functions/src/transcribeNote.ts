import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as logger from 'firebase-functions/logger';
import { onObjectFinalized } from 'firebase-functions/v2/storage';

import { REGION, SPEECH_API_KEY, SPEECH_BASE_URL, storageBucket } from './config';
import { toLogDetail } from './errors';
import { isClaimable, runTranscription } from './pipeline';
import type { NoteDoc } from './types';

/** Only the client uploads here, and only in this shape. */
const UPLOAD_PATH = /^users\/([^/]+)\/uploads\/([^/]+)$/;

/**
 * The Storage trigger. Everything about *transcribing* lives in `pipeline.ts`, which
 * `retrySweep` shares — this file is only about what it means to be woken by an object
 * landing in the bucket.
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
     * *application* failure — the server is down, the audio is junk — is caught inside
     * the pipeline, recorded on the note, and rescheduled by `attempts`/`nextAttemptAt`;
     * the handler returns normally, so Eventarc sees a success and never redelivers. A
     * *crash* is the other kind: the runtime dies before anything is written, so no
     * attempt is recorded and nothing in our own bookkeeping knows the note exists to
     * retry.
     *
     * That second case is not hypothetical. Seen 2026-08-20: the emulator's functions
     * runtime overran its startup deadline, the event was dropped, and a real recording
     * sat in `pending` with `attempts: 0` indefinitely — indistinguishable, in the UI,
     * from a note that was still working. Redelivery is one of the two things that can
     * see it; `retrySweep`'s third query is the other, for when no redelivery ever comes.
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
    const noteRef = getFirestore().doc(`users/${uid}/notes/${noteId}`);
    const snap = await noteRef.get();

    if (!snap.exists) {
      // No note to attach a transcript to. The bytes have no reason to exist.
      logger.warn('transcribeNote: no note document', { uid, noteId });
      try {
        await getStorage().bucket(bucket).file(objectName).delete({ ignoreNotFound: true });
      } catch (err) {
        logger.error('transcribeNote: failed to delete orphan audio', {
          name: objectName,
          detail: toLogDetail(err),
        });
      }
      return;
    }

    /**
     * `onObjectFinalized` can deliver more than once, and Eventarc will redeliver for up
     * to seven days on a throw. Reading the note before delegating is what keeps a
     * duplicate delivery cheap: a finished note costs one read rather than a transcript
     * we already have, and a run that is genuinely still going keeps its lock.
     *
     * The pipeline's claim transaction re-checks the same predicate, and *that* is the
     * authoritative answer — this is the early-out, and the place where the reason is
     * worth logging.
     */
    const note = snap.data() as NoteDoc;
    if (!isClaimable(note, Date.now())) {
      logger.info('transcribeNote: nothing to do', { uid, noteId, status: note.status });
      return;
    }
    if (note.status === 'transcribing') {
      // Older than any run could possibly be, so the previous attempt died. Skipping
      // here instead would strand the note permanently.
      logger.warn('transcribeNote: taking over a stale lock', { uid, noteId });
    }

    await runTranscription({
      uid,
      noteId,
      bucket,
      objectName,
      size: Number(event.data.size ?? 0),
      contentType: event.data.contentType,
      ext: event.data.metadata?.ext,
    });
  },
);
