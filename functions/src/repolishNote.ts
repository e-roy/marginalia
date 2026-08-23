import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';

import { NO_POLISH, runCleanup } from './cleanup';
import { REGION, SPEECH_API_KEY, SPEECH_BASE_URL } from './config';
import type { SpeechErrorCode } from './errors';
import type { SpeechConfig } from './speech';
import type { NoteDoc, SettingsDoc } from './types';

/**
 * Re-run the cleanup pipeline on a note's stored `rawText` (SPEC §7).
 *
 * Two things this is for: a note captured while Ollama was asleep, and a note you want
 * run through a different model after changing the pick in Settings. Neither needs the
 * audio — `rawText` is kept verbatim and never overwritten, so Stage 2 can be re-run
 * long after the recording itself was deleted.
 *
 * **This is the one caller that does not want `runCleanup`'s best-effort behaviour.**
 * Swallowing a polish failure is right on the automatic path, where the alternative is
 * losing a transcript. It is wrong here: the user asked, so a failure that silently
 * blanked an existing polish would answer their tap by making the note worse, so
 * nothing is written unless the polish actually produced text.
 */

interface RepolishResult {
  llmModel: string;
}

/**
 * Deliberately not `errors.ts`'s message for this code. That one says "the raw
 * transcript was kept", which is true on the automatic path and actively misleading
 * here — what was kept is whatever the note already had, an earlier polish included.
 * Telling someone their polish was replaced by raw text, in the very message that
 * exists to promise it wasn't, is worth six words of divergence.
 *
 * The sanitized code still travels in `details`, and the sentence names no host
 * (ADR-002).
 */
function unavailable(): HttpsError {
  const code: SpeechErrorCode = 'llm_unavailable';
  return new HttpsError(
    'unavailable',
    'Cleanup is unavailable right now, so this note is unchanged.',
    { code },
  );
}

export const repolishNote = onCall(
  {
    region: REGION,
    // Without these, `SPEECH_BASE_URL.value()` is an empty string inside the handler
    // and every request goes to `/v1/llm/chat/completions` on nowhere.
    secrets: [SPEECH_BASE_URL, SPEECH_API_KEY],
    // Unset, a v2 callable defaults to 60s. The middle of three nested deadlines:
    // the polish request gives up at 45s, this at 90s, the client at 120s.
    timeoutSeconds: 90,
  },
  async (request): Promise<RepolishResult> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const uid = request.auth.uid;

    const noteId: unknown = request.data?.noteId;
    // The Admin SDK bypasses Firestore rules, so the id is interpolated into a document
    // path with nothing else checking it. A slash would address a different document
    // entirely — including one outside this user's subtree.
    if (typeof noteId !== 'string' || noteId.length === 0 || noteId.includes('/')) {
      throw new HttpsError('invalid-argument', 'A note id is required.');
    }

    const db = getFirestore();
    const noteRef = db.doc(`users/${uid}/notes/${noteId}`);
    const snap = await noteRef.get();

    if (!snap.exists) {
      throw new HttpsError('not-found', 'That note no longer exists.');
    }
    const note = snap.data() as NoteDoc;

    // Deliberately the same set of conditions the Note screen uses to decide whether to
    // show the button, so the two cannot disagree about what is re-polishable.
    if (note.source !== 'voice') {
      throw new HttpsError(
        'failed-precondition',
        'A typed note is already exactly what you wrote.',
      );
    }
    if (note.status !== 'done') {
      throw new HttpsError('failed-precondition', 'This note is still being transcribed.');
    }
    if (note.edited) {
      throw new HttpsError(
        'failed-precondition',
        'This note has been edited, so cleaning it up would overwrite your changes.',
      );
    }

    const rawText = note.rawText ?? '';
    if (rawText.trim().length === 0) {
      throw new HttpsError(
        'failed-precondition',
        'There is no speech in this recording to clean up.',
      );
    }

    const settingsSnap = await db.doc(`users/${uid}/settings/app`).get();
    const settings = settingsSnap.exists ? (settingsSnap.data() as SettingsDoc) : null;

    // Distinguished from an outage on purpose: "it is switched off" and "it is down"
    // are different problems with different fixes, and only one of them is ours.
    if (settings?.llmModel === NO_POLISH) {
      throw new HttpsError(
        'failed-precondition',
        'Cleanup is turned off in Settings.',
      );
    }

    const cfg: SpeechConfig = {
      baseUrl: SPEECH_BASE_URL.value(),
      apiKey: SPEECH_API_KEY.value(),
    };

    const cleanup = await runCleanup(cfg, rawText, settings);

    if (cleanup.llmModel === null || cleanup.cleanText === null) {
      // Nothing is written. The note keeps whatever it already had.
      logger.warn('repolishNote: no polish produced, note left untouched', { uid, noteId });
      throw unavailable();
    }

    await noteRef.update({
      cleanText: cleanup.cleanText,
      title: cleanup.title,
      llmModel: cleanup.llmModel,
      updatedAt: FieldValue.serverTimestamp(),
    });

    logger.info('repolishNote: done', {
      uid,
      noteId,
      llmModel: cleanup.llmModel,
      chars: cleanup.cleanText.length,
    });

    return { llmModel: cleanup.llmModel };
  },
);
