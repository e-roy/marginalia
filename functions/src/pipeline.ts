import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as logger from 'firebase-functions/logger';

import { runCleanup } from './cleanup';
import { SPEECH_API_KEY, SPEECH_BASE_URL } from './config';
import { SpeechError, toClientError, toLogDetail, type SpeechErrorCode } from './errors';
import { buildPrompt } from './prompt';
import { listSttModels, pickSttModel, transcribe, type SpeechConfig } from './speech';
import type { BookDoc, NoteDoc, SettingsDoc } from './types';

/**
 * The transcription pipeline itself, with no opinion about what woke it up.
 *
 * Two callers reach this: the Storage trigger on the first attempt, and `retrySweep`
 * on every one after. Extracting it is what makes the retry path *the same code* as
 * the first attempt rather than a second implementation that only ever runs in
 * production — the class of untestable branch ADR-014 threw away.
 *
 * The trigger keeps what is genuinely about being a trigger: parsing the object path,
 * ignoring a note that is already done, and deciding whether a lock is stale enough to
 * take over. Everything below is about transcribing a note.
 */

/** Mirrors the Storage rule. The Admin SDK bypasses rules, so it re-checks for itself. */
const MAX_BYTES = 25 * 1024 * 1024;

/** SPEC §4: a note gets six attempts before the sweep gives up on it. */
export const MAX_ATTEMPTS = 6;

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/**
 * A run that dies mid-flight leaves the note locked as `transcribing`, and a later look
 * would otherwise skip it forever. The function's own timeout is 300s, so nothing older
 * than this can still be running — the lock is safe to take over.
 */
export const STALE_LOCK_MS = 10 * 60_000;

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

/**
 * Retrying these produces the identical failure, so they end the note immediately *and*
 * discard its audio — nothing will ever read those bytes again.
 *
 * Attempt exhaustion is deliberately **not** in this set. That note also ends, but its
 * audio is the thing that makes "Try again" possible once the server is awake, so it is
 * kept and left to the bucket lifecycle rule.
 */
const TERMINAL_CODES: ReadonlySet<SpeechErrorCode> = new Set<SpeechErrorCode>([
  'stt_rejected',
  'no_stt_model',
  'audio_missing',
  'audio_too_large',
]);

export function extensionFor(
  contentType: string | undefined,
  declared: string | undefined,
): string {
  if (declared && /^[a-z0-9]{2,5}$/i.test(declared)) return declared.toLowerCase();
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSIONS[base] ?? 'm4a';
}

/**
 * Whether this note is available to work on, given what it says about itself.
 *
 * Shared so the trigger and the pipeline's claim cannot disagree: the trigger reads it
 * to decide whether to bother (and to log *why* it is skipping), and the claim
 * transaction below re-reads it as the authoritative answer. A `done` note is finished;
 * a fresh `transcribing` lock belongs to a run that is still going.
 */
export function isClaimable(note: NoteDoc, nowMs: number): boolean {
  if (note.status === 'done') return false;
  if (note.status !== 'transcribing') return true;

  const updatedAt = note.updatedAt as Timestamp | undefined;
  const lockAgeMs = updatedAt ? nowMs - updatedAt.toMillis() : Number.POSITIVE_INFINITY;
  return lockAgeMs >= STALE_LOCK_MS;
}

export interface TranscriptionInput {
  uid: string;
  noteId: string;
  bucket: string;
  objectName: string;
  /** Bytes, as Storage reports them. Checked before anything is downloaded. */
  size: number;
  contentType: string | undefined;
  /** `customMetadata.ext` from the upload — preferred over sniffing the content type. */
  ext: string | undefined;
}

export type TranscriptionOutcome =
  /** Not ours to work on — already done, or someone else holds a fresh lock. */
  | { outcome: 'skipped'; reason: 'missing' | 'not-claimable' }
  | { outcome: 'done' }
  /** Failed, but will be tried again — `nextAttemptAt` says when. */
  | { outcome: 'retry'; code: SpeechErrorCode; attempts: number }
  /** Failed for good. `audioKept` decides whether Try again can do anything. */
  | { outcome: 'failed'; code: SpeechErrorCode; attempts: number; audioKept: boolean };

/**
 * Audio is transient at every hop and deleted the moment it is no longer needed. A
 * failed delete is logged but never fails the note — the bucket lifecycle rule is the
 * backstop that makes "audio is never kept" true rather than merely intended.
 */
async function discardAudio(bucket: string, name: string): Promise<void> {
  try {
    await getStorage().bucket(bucket).file(name).delete({ ignoreNotFound: true });
  } catch (err) {
    logger.error('pipeline: failed to delete audio', { name, detail: toLogDetail(err) });
  }
}

/**
 * Claim the note and record the attempt, atomically, **before any outbound call**.
 *
 * This is what makes a second caller safe. Two things have to be true together: the
 * attempt has to be counted (or no note ever exhausts and `retrySweep` retries forever),
 * and the lock has to land before the long work (or two callers can both be inside the
 * pipeline for the same note, burning two GPU passes on one recording). A transaction
 * is what makes them one decision rather than two.
 */
async function claim(
  input: TranscriptionInput,
): Promise<{ note: NoteDoc; attempts: number } | { skipped: 'missing' | 'not-claimable' }> {
  const db = getFirestore();
  const noteRef = db.doc(`users/${input.uid}/notes/${input.noteId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(noteRef);
    if (!snap.exists) return { skipped: 'missing' as const };

    const note = snap.data() as NoteDoc;
    if (!isClaimable(note, Date.now())) return { skipped: 'not-claimable' as const };

    const attempts = (note.attempts ?? 0) + 1;
    tx.update(noteRef, {
      status: 'transcribing',
      attempts,
      audioPath: input.objectName,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { note, attempts };
  });
}

/**
 * Transcribe (Stage 1), polish (Stage 2 via `runCleanup`), write both texts
 * back, and delete the object.
 *
 * `rawText` is stored verbatim and never overwritten; `cleanText` is what the UI shows.
 * Note that `runCleanup` cannot throw an LLM error — see `cleanup.ts` — so an Ollama
 * outage never reaches the failure classifier below and can never cost a note its
 * transcript.
 */
export async function runTranscription(
  input: TranscriptionInput,
): Promise<TranscriptionOutcome> {
  const { uid, noteId, bucket, objectName } = input;

  const claimed = await claim(input);
  if ('skipped' in claimed) {
    logger.info('pipeline: nothing to do', { uid, noteId, reason: claimed.skipped });
    return { outcome: 'skipped', reason: claimed.skipped };
  }

  const { note, attempts } = claimed;
  const db = getFirestore();
  const noteRef = db.doc(`users/${uid}/notes/${noteId}`);

  try {
    if (input.size > MAX_BYTES) {
      throw new SpeechError('audio_too_large', `${input.size} bytes exceeds ${MAX_BYTES}`);
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
      filename: `${noteId}.${extensionFor(input.contentType, input.ext)}`,
      contentType: input.contentType ?? 'audio/mp4',
      model,
      prompt: buildPrompt(note.bookTitle, book, note.chapter),
    });

    // Stage 2. Best-effort by construction: at worst this returns `cleanText: null`
    // and the UI falls back to the transcript — a sleeping Ollama can never cost a
    // note its transcript, which is the whole point of ADR-012.
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

    /**
     * `bytes` and `durationMs` together are the only way to tell two very different
     * failures apart after the audio is gone, and the audio is always gone.
     *
     * `durationMs` is the client's wall clock across the recording; `bytes` is what
     * actually reached Storage. If the blob is far smaller than the duration implies,
     * `MediaRecorder` truncated the recording and the words were never captured. If it
     * matches, the audio was intact and anything missing from `rawText` was dropped by
     * the transcription model. Without both numbers those look identical from here —
     * seen 2026-08-22, when trailing sentences went missing on the first real phone
     * recordings and nothing logged could say which end lost them.
     *
     * `kbps` also answers SPEC §12's open question about the real recording bitrate:
     * it claims 2.4 MB per ten minutes (32 kbps), and Chrome ignored
     * `audioBitsPerSecond` entirely and produced roughly 99.
     */
    const durationMs = note.durationMs ?? null;
    logger.info('pipeline: done', {
      uid,
      noteId,
      attempts,
      model,
      llmModel: cleanup.llmModel,
      rawChars: rawText.length,
      cleanChars: cleanup.cleanText?.length ?? null,
      bytes: input.size,
      durationMs,
      kbps:
        durationMs && durationMs > 0
          ? Math.round((input.size * 8) / durationMs)
          : null,
      contentType: input.contentType ?? null,
    });
    return { outcome: 'done' };
  } catch (err) {
    const clientError = toClientError(err);

    /**
     * Two ways to end, and they differ in what happens to the audio.
     *
     * A terminal *code* means the request failed in a way that will fail identically
     * next time, so the bytes are dead weight and go now. **Exhaustion is different**:
     * the recording is fine and the server was not, so the audio is what makes Try
     * again worth offering once the Mac Mini is awake. It is kept, and the bucket
     * lifecycle rule reclaims it after about a day.
     */
    const terminalCode = TERMINAL_CODES.has(clientError.code);
    const exhausted = attempts >= MAX_ATTEMPTS;
    const ended = terminalCode || exhausted;

    logger.error('pipeline: failed', {
      uid,
      noteId,
      attempts,
      terminalCode,
      exhausted,
      detail: toLogDetail(err),
    });

    await noteRef.update({
      // `failed` means "gave up". Anything retryable goes back to `pending` for the
      // sweep to pick up — the note keeps its audio until then either way.
      status: ended ? 'failed' : 'pending',
      error: clientError,
      audioPath: terminalCode ? null : objectName,
      nextAttemptAt: ended
        ? null
        : Timestamp.fromMillis(
            Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS),
          ),
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (terminalCode) await discardAudio(bucket, objectName);

    return ended
      ? {
          outcome: 'failed',
          code: clientError.code,
          attempts,
          audioKept: !terminalCode,
        }
      : { outcome: 'retry', code: clientError.code, attempts };
  }
}
