import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';

import { REGION, SPEECH_API_KEY, SPEECH_BASE_URL } from './config';
import { toLogDetail } from './errors';
import { listLlmModels, listSttModels, type SpeechConfig } from './speech';
import type { ServerHealth } from './types';

/**
 * Discovery. No model name is hardcoded anywhere in this app, because
 * `PRELOAD_MODELS` gates what is loadable on the server and nothing downloads at
 * request time — a hardcoded model that isn't preloaded is a guaranteed 4xx, not a
 * slow path (SPEC §5).
 *
 * Auth-required and callable-only: there is no unauthenticated path to the Mac Mini.
 */
export const serverHealth = onCall(
  {
    region: REGION,
    secrets: [SPEECH_BASE_URL, SPEECH_API_KEY],
    timeoutSeconds: 60,
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

    const health: ServerHealth = {
      ok: stt.status === 'fulfilled',
      llmOk: llm.status === 'fulfilled',
      stt: stt.status === 'fulfilled' ? stt.value : [],
      llm: llm.status === 'fulfilled' ? llm.value : [],
      checkedAt: new Date().toISOString(),
    };

    // Cached so Settings and a cold-start transcription can read the last known lists
    // without another round trip to a machine that may be asleep.
    await getFirestore()
      .doc(`users/${uid}/settings/app`)
      .set({ lastHealth: health }, { merge: true });

    return health;
  },
);
