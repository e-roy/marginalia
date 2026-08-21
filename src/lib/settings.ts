import { doc, setDoc } from 'firebase/firestore'

import { db } from '@/lib/firebase'

/**
 * The per-user settings document (SPEC §6). One document so the function can read it
 * in a single get on the way to transcribing.
 *
 * `lastHealth` is written by the `serverHealth` callable, never from here — the client
 * has no way to discover models and no business inventing them.
 */
export function settingsRef(uid: string) {
  return doc(db, `users/${uid}/settings/app`)
}

/** Null means auto-pick (SPEC §5). Merged, so it never clobbers `lastHealth`. */
export function setSttModel(uid: string, model: string | null): Promise<void> {
  return setDoc(settingsRef(uid), { sttModel: model }, { merge: true })
}

/** Null means auto-pick; `'none'` turns Stage 3 off entirely (SPEC §6). */
export function setLlmModel(uid: string, model: string | null): Promise<void> {
  return setDoc(settingsRef(uid), { llmModel: model }, { merge: true })
}

/**
 * Which discovered ids may be *offered* as transcription models.
 *
 * The same `/whisper/i` plus not-`/kokoro/i` test as `pickSttModel` in
 * `functions/src/speech.ts`, duplicated rather than shared because that module holds
 * the speech server's address and key and must never reach this bundle.
 *
 * Not tidiness. `GET /v1/models` also lists a TTS voice and a VAD model, because the
 * server preloads them alongside the whisper ones. Pinning either would make every
 * later recording fail with `stt_rejected` — a terminal code, which deletes the
 * recording's audio. An unrecoverable note, lost to a dropdown.
 *
 * Note this is a different thing from the omission described in `ServerCard.tsx`,
 * which is about not *predicting* the auto-pick in the client. This filters what may
 * be offered and says nothing about which id wins; `ServerCard` goes on listing the
 * server's inventory unfiltered, and that listing is the diagnostic that made "listed
 * is not the same as loadable" visible in the first place.
 */
export function transcriptionModels(ids: string[]): string[] {
  return ids.filter((id) => /whisper/i.test(id) && !/kokoro/i.test(id))
}
