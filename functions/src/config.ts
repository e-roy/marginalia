import { defineSecret } from 'firebase-functions/params';

/**
 * The address of a Mac Mini in a house, and a bearer token that grants GPU access.
 *
 * Both are Secret Manager secrets resolved at runtime inside the function. Neither is
 * a build-time value, so neither can be inlined into any artefact. In the emulator the
 * values come from `functions/.secret.local`, which is gitignored.
 *
 * Neither may ever be logged, returned to a caller, or written to Firestore. See
 * SPEC §2 and `errors.ts`.
 */
export const SPEECH_BASE_URL = defineSecret('SPEECH_BASE_URL');
export const SPEECH_API_KEY = defineSecret('SPEECH_API_KEY');

/**
 * Functions belong in the region matching the Firestore location, or every audio read
 * pays cross-region egress (SPEC §2). No real project exists yet; `us-central1` pairs
 * with the `nam5` default. Decide this deliberately at project creation — a Firestore
 * location is permanent.
 */
export const REGION = 'us-central1';

/**
 * The bucket `transcribeNote` listens to.
 *
 * `onObjectFinalized` will infer this from `FIREBASE_CONFIG` if you let it — but the
 * emulator runs against `demo-marginalia`, which has no real project behind it and so
 * no `storageBucket` in that config. The inference then throws while the emulator is
 * discovering functions, and the only symptom is
 * `Cannot determine backend specification. Timeout after 10000` — which says nothing
 * about buckets. Resolving it explicitly is what makes that failure impossible.
 *
 * Deployed, the value always comes from `FIREBASE_CONFIG`, so no bucket name is
 * hardcoded. Locally it is derived from the demo project id, and a `demo-` project
 * cannot touch production by construction. Anything else fails loudly, because a
 * trigger bound to the wrong bucket simply never fires.
 */
export function storageBucket(): string {
  const raw = process.env.FIREBASE_CONFIG;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const bucket =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>).storageBucket
          : null;
      if (typeof bucket === 'string' && bucket.length > 0) return bucket;
    } catch {
      // Fall through to the emulator case below.
    }
  }

  const project = process.env.GCLOUD_PROJECT ?? '';
  if (project.startsWith('demo-')) return `${project}.appspot.com`;

  throw new Error('storageBucket: FIREBASE_CONFIG carries no storageBucket');
}
