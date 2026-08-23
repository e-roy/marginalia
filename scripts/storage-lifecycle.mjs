#!/usr/bin/env node
/**
 * Applies `storage.lifecycle.json` to the production audio bucket.
 *
 * **Why this is a script and not part of `firebase deploy`.** A bucket lifecycle rule
 * is a Cloud Storage setting, not a Firebase one — `firebase.json` has nowhere to put
 * it and `storage.rules` governs access, not retention. That is why `SPEC §10` has
 * assumed this rule since the first draft while nothing ever created it.
 *
 * **What it is for.** `transcribeNote` deletes audio the moment a transcript commits,
 * and immediately for a recording the server rejected outright. Two cases that code
 * cannot cover:
 *
 *   1. A run that crashed between the upload and its own delete.
 *   2. Since M6, a note that gave up after six attempts and deliberately **keeps** its
 *      audio, so that "Try again" has something to act on once the Mac Mini is awake.
 *
 * The second is the one that makes this rule load-bearing rather than tidy: without it,
 * failed notes would accumulate audio with nothing to reclaim it, and "audio is never
 * kept" would quietly stop being true.
 *
 * **`matchesPrefix: ["users/"]`, not a per-user uploads path.** GCS prefixes are
 * literal — there is no wildcard to put a uid in the middle of a prefix. That is not
 * over-broad in practice:
 * `storage.rules` permits client writes only under `users/{uid}/uploads/{noteId}` and
 * denies everything else outright, so nothing else can exist beneath `users/`.
 *
 * **`age: 1` means about a day, not exactly 24 hours.** GCS evaluates lifecycle
 * asynchronously, roughly daily, so an object can outlive its age by up to another day.
 * `SPEC §1` and `§10` are worded to match — overstating the precision of a retention
 * promise in a public repo would be worse than the extra day.
 */
import { spawn } from 'node:child_process'

const BUCKET = process.env.MARGINALIA_BUCKET ?? 'marginalia-e957c.firebasestorage.app'

const args = [
  'storage',
  'buckets',
  'update',
  `gs://${BUCKET}`,
  '--lifecycle-file=storage.lifecycle.json',
]

console.log(`gcloud ${args.join(' ')}\n`)

const child = spawn('gcloud', args, { stdio: 'inherit', shell: true })

child.on('error', () => {
  console.error(
    '\nCould not run gcloud. Install the Google Cloud CLI, or apply the rule by hand:\n' +
      `  gcloud ${args.join(' ')}\n` +
      'Then confirm it with:\n' +
      `  gcloud storage buckets describe gs://${BUCKET} --format="value(lifecycle)"`,
  )
  process.exit(1)
})

child.on('exit', (code) => {
  if (code === 0) {
    console.log(
      '\nApplied. Confirm with:\n' +
        `  gcloud storage buckets describe gs://${BUCKET} --format="value(lifecycle)"`,
    )
  }
  process.exit(code ?? 1)
})
