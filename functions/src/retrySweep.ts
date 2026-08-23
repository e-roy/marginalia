import {
  FieldValue,
  getFirestore,
  Timestamp,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { REGION, SPEECH_API_KEY, SPEECH_BASE_URL, storageBucket } from './config';
import { clientErrorFor, toLogDetail } from './errors';
import { MAX_ATTEMPTS, runTranscription, STALE_LOCK_MS } from './pipeline';
import type { NoteDoc } from './types';

/**
 * The thing that makes a sleeping Mac Mini a delay rather than a lost note (SPEC §4).
 *
 * `transcribeNote` has always written the backoff — `attempts` and `nextAttemptAt` —
 * and nothing has ever read it. This is the reader. It runs every five minutes and
 * re-runs the same pipeline the first attempt used, so the retry path cannot drift away
 * from the path it is retrying.
 */

/**
 * When to stop *starting* notes. The note already running finishes inside the headroom
 * that leaves:
 *
 *   BUDGET_MS + worst single note + per-run overhead  ≤  timeoutSeconds  ≤  interval
 *   100s      + (155s + 25s)      + 20s               ≤  300s            ≤  300s
 *
 * 155s is the worst a note's calls to the speech server can cost — `speech.ts`'s
 * DISCOVERY_TIMEOUT_MS 15s + TRANSCRIBE_TIMEOUT_MS 95s + POLISH_TIMEOUT_MS 45s, and
 * reachable: a slow transcription that succeeds, then a polish that hangs to its own
 * deadline. **If any of those three moves, this number moves.** The 25s covers what
 * those budgets do not — a download of up to 25 MB from Storage, `getMetadata`, the
 * settings and book reads, two writes and the audio delete. The 20s covers the three
 * queries below plus slack.
 *
 * Getting this wrong is not merely wasteful. A run killed mid-note has already counted
 * its attempt and written nothing else, and `attempts` is the only thing the exhaustion
 * verdict reads — so too generous a budget lets a note burn 1→6 across successive
 * sweeps and end up `failed` without one transcription ever having been attempted end
 * to end.
 */
const BUDGET_MS = 100_000;

/** Page size per query. The budget above, not this, is what bounds a run. */
const BATCH = 20;

/**
 * How old an *unstamped* `pending` note must be before the backstop query touches it.
 *
 * Not the same constant as the client's `UPLOAD_GRACE_MS` in `src/lib/notes.ts`, which
 * decides when a freshly uploaded note becomes eligible for the backoff query. They
 * start equal and are free to diverge — this one is about notes nothing ever stamped.
 */
const UNSTAMPED_AGE_MS = 5 * 60_000;

export interface SweepSummary {
  found: { deadLock: number; backoff: number; unstamped: number };
  /** How many survived deduplication — see `dedupeByPath`. */
  candidates: number;
  retried: number;
  gaveUp: number;
  skipped: number;
  /** True when the run stopped early; `remaining` is what it did not get to. */
  budgetStopped: boolean;
  remaining: number;
}

/**
 * One document per path, first occurrence winning.
 *
 * Pure and exported on purpose. Under the design's own semantics no note can satisfy
 * two of the three queries below — 1 and 3 are disjoint because a Firestore inequality
 * on a Timestamp skips `null` (measured, 2026-08-22), and 2 is `transcribing` against
 * the others' `pending`. So there is no database state that exercises this, and a test
 * driven through Firestore would pass by finding nothing to deduplicate. Its whole job
 * is to be right if that assumption ever stops holding, which is exactly the kind of
 * code that must not be verified only by a probe that cannot fail.
 */
export function dedupeByPath(
  ...sets: QueryDocumentSnapshot[][]
): QueryDocumentSnapshot[] {
  const seen = new Set<string>();
  const out: QueryDocumentSnapshot[] = [];
  for (const set of sets) {
    for (const snap of set) {
      if (seen.has(snap.ref.path)) continue;
      seen.add(snap.ref.path);
      out.push(snap);
    }
  }
  return out;
}

/**
 * The three ways a note gets stuck, oldest first within each.
 *
 * Firestore requires the first `orderBy` to be the inequality field, which is also what
 * makes "oldest first" free. All three are collection-group queries — the sweep runs
 * across every user — and so need `COLLECTION_GROUP` index scope, which is not the same
 * index a per-user query would use.
 *
 * **Each needs its own index; they do not share by prefix.** Queries 1 and 3 differ only
 * in the trailing field, and the first deployed sweep failed every tick with
 * `FAILED_PRECONDITION` because `status, nextAttemptAt, updatedAt` was assumed to serve
 * query 1 as well. It does not: a composite index sorts by each field in turn and then
 * `__name__`, and query 1 orders by `nextAttemptAt, __name__`, so `updatedAt` sitting
 * between them makes the index unusable for it. The emulator answers all three either
 * way, so only a deployed run can prove this.
 */
async function findStuck(nowMs: number) {
  const db = getFirestore();
  const notes = db.collectionGroup('notes');
  const now = Timestamp.fromMillis(nowMs);

  const [deadLock, backoff, unstamped] = await Promise.all([
    // A run that was killed mid-note. `transcribeNote` only takes a lock over when a
    // redelivery arrives; when the crash killed the delivery too, this is the only
    // thing that ever looks again.
    notes
      .where('status', '==', 'transcribing')
      .where('updatedAt', '<=', Timestamp.fromMillis(nowMs - STALE_LOCK_MS))
      .orderBy('updatedAt')
      .limit(BATCH)
      .get(),

    // The backoff queue: a recorded failure that has waited out its delay.
    notes
      .where('status', '==', 'pending')
      .where('nextAttemptAt', '<=', now)
      .orderBy('nextAttemptAt')
      .limit(BATCH)
      .get(),

    // Never looked at. The ADR-008 case: the delivery was dropped, so nothing was ever
    // written and `nextAttemptAt` is still null — which the query above cannot see.
    notes
      .where('status', '==', 'pending')
      .where('nextAttemptAt', '==', null)
      .where('updatedAt', '<=', Timestamp.fromMillis(nowMs - UNSTAMPED_AGE_MS))
      .orderBy('updatedAt')
      .limit(BATCH)
      .get(),
  ]);

  return {
    found: {
      deadLock: deadLock.size,
      backoff: backoff.size,
      unstamped: unstamped.size,
    },
    candidates: dedupeByPath(deadLock.docs, backoff.docs, unstamped.docs),
  };
}

/**
 * The one verdict the sweep issues on its own.
 *
 * A note whose runs kept being killed has a growing `attempts` and no error, because
 * the classifier that would have written one was the thing that got killed. Without
 * this it would be taken over every ten minutes forever and never reach `failed` — so
 * **Try again**, which only appears on a failed note, would never surface it.
 *
 * The audio is kept, or the button this creates would have nothing to act on.
 */
async function giveUp(
  snap: QueryDocumentSnapshot,
  uid: string,
  objectName: string,
): Promise<void> {
  logger.warn('retrySweep: giving up on a note whose runs kept being cut short', {
    uid,
    noteId: snap.id,
    attempts: (snap.data() as NoteDoc).attempts ?? 0,
  });

  await snap.ref.update({
    status: 'failed',
    error: clientErrorFor('run_interrupted'),
    audioPath: objectName,
    nextAttemptAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * One pass. Exported separately from the schedule so it can be driven directly against
 * the emulator — firebase-tools does not fire scheduled functions locally, and a design
 * that could only be exercised in production is the thing this milestone exists to
 * avoid.
 */
export async function sweepOnce(nowMs: number): Promise<SweepSummary> {
  const startedAt = Date.now();
  const bucket = storageBucket();
  const { found, candidates } = await findStuck(nowMs);

  const summary: SweepSummary = {
    found,
    candidates: candidates.length,
    retried: 0,
    gaveUp: 0,
    skipped: 0,
    budgetStopped: false,
    remaining: 0,
  };

  for (const [index, snap] of candidates.entries()) {
    if (Date.now() - startedAt >= BUDGET_MS) {
      // Never silently: a truncated sweep otherwise reads as "nothing left to do".
      summary.budgetStopped = true;
      summary.remaining = candidates.length - index;
      break;
    }

    // `users/{uid}/notes/{noteId}` — the collection's parent is the user document.
    const uid = snap.ref.parent.parent?.id;
    if (!uid) {
      logger.error('retrySweep: note outside a user subtree', { path: snap.ref.path });
      summary.skipped += 1;
      continue;
    }

    const note = snap.data() as NoteDoc;
    const objectName = note.audioPath ?? `users/${uid}/uploads/${snap.id}`;

    // SPEC §4 bounds the sweep by attempts as well as by time. Checked here rather than
    // in the query: a second inequality field would have to join every index and every
    // orderBy, and the batch is small enough that this costs nothing.
    if ((note.attempts ?? 0) >= MAX_ATTEMPTS) {
      if (note.status === 'transcribing') {
        await giveUp(snap, uid, objectName);
        summary.gaveUp += 1;
      } else {
        // Already classified by the pipeline; nothing for the sweep to add.
        summary.skipped += 1;
      }
      continue;
    }

    /**
     * The trigger gets size and content type from the event. Here they come from the
     * object itself — and if it has gone, the pipeline's own `audio_missing` path is
     * the right answer, so a failure to read metadata is passed through rather than
     * handled separately.
     */
    let size = 0;
    let contentType: string | undefined;
    let ext: string | undefined;
    try {
      const [metadata] = await getStorage().bucket(bucket).file(objectName).getMetadata();
      size = Number(metadata.size ?? 0);
      contentType = metadata.contentType;
      ext = (metadata.metadata?.ext as string | undefined) ?? undefined;
    } catch (err) {
      logger.warn('retrySweep: could not read the audio object', {
        uid,
        noteId: snap.id,
        detail: toLogDetail(err),
      });
    }

    const result = await runTranscription({
      uid,
      noteId: snap.id,
      bucket,
      objectName,
      size,
      contentType,
      ext,
    });

    if (result.outcome === 'skipped') summary.skipped += 1;
    else if (result.outcome === 'failed') summary.gaveUp += 1;
    else summary.retried += 1;
  }

  logger.info('retrySweep: pass complete', {
    ...summary,
    elapsedMs: Date.now() - startedAt,
  });
  return summary;
}

export const retrySweep = onSchedule(
  {
    region: REGION,
    schedule: 'every 5 minutes',
    secrets: [SPEECH_BASE_URL, SPEECH_API_KEY],
    /**
     * 300s keeps a run inside its own tick, so `maxInstances: 1` is a guard that should
     * never have to fire rather than the thing holding the design together. See
     * `BUDGET_MS` for the arithmetic.
     */
    timeoutSeconds: 300,
    memory: '512MiB',
    maxInstances: 1,
  },
  async () => {
    await sweepOnce(Date.now());
  },
);
