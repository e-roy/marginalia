import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';

import { NO_POLISH } from './cleanup';
import { REGION, SPEECH_API_KEY, SPEECH_BASE_URL } from './config';
import { toLogDetail } from './errors';
import {
  listLlmModels,
  listSttModels,
  pickLlmModel,
  probeLlm,
  type SpeechConfig,
} from './speech';
import type { ServerHealth, SettingsDoc } from './types';

/**
 * Discovery, and a real test of the cleanup model.
 *
 * No model name is hardcoded anywhere in this app, because `PRELOAD_MODELS` gates what
 * is loadable on the server and nothing downloads at request time — a hardcoded model
 * that isn't preloaded is a guaranteed 4xx, not a slow path (SPEC §5).
 *
 * **Listing is not proof.** M4 found `GET /v1/llm/models` returning six models in half a
 * second while the model auto-pick chooses could not complete a single chat completion.
 * `llmOk` keeps its original meaning — the list came back — and `llmUsable` is the new,
 * honest one: the model that would actually be used answered.
 *
 * Auth-required and callable-only: there is no unauthenticated path to the Mac Mini.
 */
export const serverHealth = onCall(
  {
    region: REGION,
    secrets: [SPEECH_BASE_URL, SPEECH_API_KEY],
    /**
     * The middle of three nested deadlines, and it had to grow for the probe: 15s of
     * discovery plus a 45s probe is 60s of upstream work, which is exactly what this
     * used to allow in total. The probe request gives up at 45s, this at 120s, and the
     * client at 150s (`checkServerHealth`). Same shape as ADR-012's polish stack.
     */
    timeoutSeconds: 120,
  },
  async (request): Promise<ServerHealth> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const uid = request.auth.uid;

    const cfg: SpeechConfig = {
      baseUrl: SPEECH_BASE_URL.value(),
      apiKey: SPEECH_API_KEY.value(),
    };

    // Settled, not all: Ollama fails independently of STT, and an LLM outage must
    // never be reported as "the speech server is down".
    const [stt, llm] = await Promise.allSettled([listSttModels(cfg), listLlmModels(cfg)]);

    if (stt.status === 'rejected') {
      logger.warn('serverHealth: STT discovery failed', { detail: toLogDetail(stt.reason) });
    }
    if (llm.status === 'rejected') {
      logger.warn('serverHealth: LLM discovery failed', { detail: toLogDetail(llm.reason) });
    }

    const llmIds = llm.status === 'fulfilled' ? llm.value : [];

    /**
     * Probe the model this user's next note would actually use — the pinned one, or
     * whatever auto-pick would land on. Probing the *list* would answer a different and
     * more expensive question, and choosing differently on the strength of the answer
     * is a `SPEC §5` decision this deliberately does not make: it reports, so that
     * decision has evidence when someone comes to take it.
     */
    const settingsRef = getFirestore().doc(`users/${uid}/settings/app`);
    const settingsSnap = await settingsRef.get();
    const settings = settingsSnap.exists ? (settingsSnap.data() as SettingsDoc) : null;

    const pinned = settings?.llmModel ?? null;
    const wouldUse =
      pinned === NO_POLISH ? null : (pinned ?? pickLlmModel(llmIds));

    const llmProbed = wouldUse && llmIds.length > 0 ? wouldUse : null;
    const llmUsable = llmProbed !== null && (await probeLlm(cfg, llmProbed));

    if (llmProbed && !llmUsable) {
      logger.warn('serverHealth: the cleanup model is listed but did not answer', {
        model: llmProbed,
      });
    }

    const health: ServerHealth = {
      ok: stt.status === 'fulfilled',
      llmOk: llm.status === 'fulfilled',
      llmProbed,
      llmUsable,
      stt: stt.status === 'fulfilled' ? stt.value : [],
      llm: llmIds,
      checkedAt: new Date().toISOString(),
    };

    // Cached so Settings and a cold-start transcription can read the last known lists
    // without another round trip to a machine that may be asleep.
    await settingsRef.set({ lastHealth: health }, { merge: true });

    return health;
  },
);
