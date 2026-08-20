import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions';

import { REGION } from './config';

initializeApp();

// One region for every function, matching the Firestore location. See `config.ts`.
setGlobalOptions({ region: REGION, maxInstances: 10 });

export { serverHealth } from './serverHealth';
export { transcribeNote } from './transcribeNote';
