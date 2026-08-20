/**
 * The device-side audio queue.
 *
 * A recording goes into IndexedDB before anything else happens, so the UI is finished
 * the moment you stop talking — lock the phone and walk away. The blob lives here until
 * Storage has it, and is deleted the instant that succeeds.
 *
 * iOS has no Background Sync, so whatever the phone still holds when the app closes
 * stays held until the app reopens (SPEC §4). And Safari evicts site data after roughly
 * seven days of non-use *unless the app is installed to the Home Screen* — which is why
 * installation is a feature here, not polish.
 *
 * Raw IndexedDB rather than a wrapper library: this is four operations on one object
 * store, and a dependency would be larger than the code.
 */

const DB_NAME = 'marginalia-audio'
const DB_VERSION = 1
const STORE = 'pending'

export interface QueuedAudio {
  /** Same id as the Firestore note document — that is what ties the two together. */
  noteId: string
  uid: string
  blob: Blob
  mime: string
  ext: string
  queuedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'noteId' })
        // The queue is always drained for one signed-in user at a time.
        store.createIndex('uid', 'uid', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
  })
  return dbPromise
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const request = work(tx.objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
      }),
  )
}

export function putAudio(entry: QueuedAudio): Promise<IDBValidKey> {
  return run('readwrite', (store) => store.put(entry))
}

export function deleteAudio(noteId: string): Promise<undefined> {
  return run('readwrite', (store) => store.delete(noteId))
}

/** Oldest first, so a backlog drains in the order it was recorded. */
export async function listAudio(uid: string): Promise<QueuedAudio[]> {
  const all = await run<QueuedAudio[]>('readonly', (store) =>
    store.index('uid').getAll(uid),
  )
  return all.sort((a, b) => a.queuedAt - b.queuedAt)
}

export function countAudio(uid: string): Promise<number> {
  return run('readonly', (store) => store.index('uid').count(uid))
}
