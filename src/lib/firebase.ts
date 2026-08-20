/**
 * Firebase SDK initialisation.
 *
 * NOTE: every value here is a PUBLIC identifier. Firebase web config ships in the
 * client bundle of every Firebase app and cannot be hidden — security comes from
 * Firestore/Storage rules and a restricted OAuth consent screen.
 *
 * The speech server's hostname and API key are a different category entirely. They
 * live in Secret Manager, are read only inside Cloud Functions, and must NEVER carry
 * a VITE_ prefix — Vite inlines those into the bundle at build time. The browser
 * never contacts the speech server at all. See CLAUDE.md.
 */
import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore'
import { connectStorageEmulator, getStorage } from 'firebase/storage'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const app = initializeApp(config)

export const auth = getAuth(app)

/**
 * Firestore keeps its own IndexedDB cache. This is what makes the app work offline —
 * the service worker caches the app shell only and must never touch Firestore traffic.
 */
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})

export const storage = getStorage(app)

// Cloud Functions land in Milestone 2, together with their emulator entry in
// firebase.json. Deliberately not exported yet: a functions client that isn't wired to
// the emulator would silently point at production.

export const usingEmulators = import.meta.env.VITE_USE_EMULATORS === 'true'

if (usingEmulators) {
  // Vite HMR re-runs this module; connecting twice throws. The flag on globalThis
  // survives module reloads where a module-level boolean would not.
  const g = globalThis as typeof globalThis & { __marginaliaEmulators?: boolean }
  if (!g.__marginaliaEmulators) {
    g.__marginaliaEmulators = true
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
    connectFirestoreEmulator(db, '127.0.0.1', 8080)
    connectStorageEmulator(storage, '127.0.0.1', 9199)
    console.info(
      `[marginalia] Firebase emulators connected (project: ${config.projectId})`,
    )
  }
}
