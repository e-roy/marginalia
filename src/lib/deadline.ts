/**
 * A deadline for a call that has none of its own.
 *
 * Its own module, importing nothing, because two callers now need it and both wait on
 * Firestore: `deleteBook` reads the server before a cascade, and `exportAll` reads
 * everything before writing a file. Neither SDK call bounds its own wait, and this project
 * has been bitten by that twice — `getDocsFromServer` retrying with backoff forever once a
 * session exists, and M5's `openlibrary.org/search.json` hanging at ~21s. One helper is
 * what stops the two call sites drifting apart.
 *
 * Importing nothing is also what keeps it free to be imported *by* `books.ts` without
 * anyone having to think about direction.
 */

/**
 * The sanitized code the UI maps to "no connection", deliberately matching Firestore's
 * own `unavailable` so a caller can handle both with one check.
 *
 * The message is the caller's, not this module's: what timed out and what it cost differ
 * completely between refusing to delete a book and falling back to a cached export.
 */
export class ServerUnreachableError extends Error {
  readonly code = 'unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'ServerUnreachableError'
  }
}

export function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ServerUnreachableError(message)), ms)
  })
  // The losing promise is left to settle on its own — there is no way to cancel a
  // Firestore read, and it has no side effects to clean up.
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}
