/**
 * Open Library lookup (SPEC §9).
 *
 * Called directly from the browser: the API is public, CORS-enabled, and needs no key,
 * so there is nothing here worth proxying through a function. Note the contrast with
 * the speech server — that one the browser never touches at all.
 *
 * Every path through this module is optional. Search failing is not an error state the
 * user has to resolve; manual entry is always available and always the fallback.
 */

const SEARCH_URL = 'https://openlibrary.org/search.json'
const LOOKUP_URL = 'https://openlibrary.org/api/books'
const COVERS_URL = 'https://covers.openlibrary.org/b/id'

/**
 * Neither endpoint is fast and one of them can stop answering entirely: on 2026-08-21
 * `search.json` timed out at ~21s on four consecutive attempts from a machine where
 * `api/books` answered in 3.7–9.9s. Without a deadline of our own the add-book sheet
 * spins forever and its "add it by hand" fallback — which is always available and is
 * the whole point of `SPEC §9`'s third path — never appears.
 *
 * Lookup gets the longer budget because it legitimately takes up to ten seconds.
 */
const SEARCH_TIMEOUT_MS = 8_000
const LOOKUP_TIMEOUT_MS = 12_000

/** What the shelf needs from a hit, already flattened out of the API shape. */
export interface BookCandidate {
  /**
   * Open Library key. Search returns a **work** key (`/works/OL45804W`); the ISBN
   * lookup returns an **edition** key (`/books/OL34192801M`), which for a scanned
   * physical copy is the more precise referent. Null when the hit has neither.
   */
  openLibraryKey: string | null
  title: string
  authors: string[]
  coverUrl: string | null
  firstPublishYear: number | null
  /** Only the scan path knows this; search never reports an ISBN. */
  isbn13: string | null
}

/** The subset of `search.json` we ask for — anything else is not requested. */
interface SearchDoc {
  key?: string
  title?: string
  author_name?: string[]
  cover_i?: number
  first_publish_year?: number
}

/**
 * The subset of an `api/books?jscmd=data` record we read. The full record also carries
 * subjects, classifications, publishers and pagination; none of it is wanted.
 */
interface LookupRecord {
  key?: string
  title?: string
  authors?: { name?: string }[]
  cover?: { small?: string; medium?: string; large?: string }
}

/**
 * `-M` is the middle size, ~180px wide. Large is wasted on a strip of four covers on a
 * phone, and small is visibly soft on a retina screen.
 */
export function coverUrl(coverId: number, size: 'S' | 'M' | 'L' = 'M'): string {
  return `${COVERS_URL}/${coverId}-${size}.jpg`
}

function toCandidate(doc: SearchDoc): BookCandidate | null {
  // A hit with no title is not something anyone can pick from a list.
  if (!doc.title) return null

  return {
    openLibraryKey: doc.key ?? null,
    title: doc.title,
    authors: doc.author_name ?? [],
    coverUrl: doc.cover_i === undefined ? null : coverUrl(doc.cover_i),
    firstPublishYear: doc.first_publish_year ?? null,
    isbn13: null,
  }
}

/**
 * Our deadline, combined with whatever the caller already had. `AbortSignal.any` means
 * a superseded keystroke and an expired timeout arrive at `fetch` the same way, so
 * neither needs special handling downstream.
 */
function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Eight is what fits on a phone screen without becoming a scroll exercise, and the
 * field list keeps the response small — the unfiltered document is enormous.
 *
 * Rejects only on a genuine transport failure; an aborted request resolves empty so a
 * superseded keystroke doesn't surface as an error.
 */
export async function searchBooks(
  query: string,
  signal?: AbortSignal,
): Promise<BookCandidate[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  const url = new URL(SEARCH_URL)
  url.searchParams.set('q', trimmed)
  url.searchParams.set('fields', 'key,title,author_name,cover_i,first_publish_year')
  url.searchParams.set('limit', '8')

  let response: Response
  try {
    response = await fetch(url, { signal: withTimeout(SEARCH_TIMEOUT_MS, signal) })
  } catch (err) {
    // Deliberately the CALLER's signal, not the composed one. A superseded keystroke
    // resolves empty; a timeout does not, because the user is owed the "add it by
    // hand" message rather than a list that silently stays empty forever.
    if (signal?.aborted) return []
    throw err
  }

  if (!response.ok) {
    throw new Error(`Open Library search failed (${response.status})`)
  }

  const body = (await response.json()) as { docs?: SearchDoc[] }
  return (body.docs ?? []).map(toCandidate).filter((hit): hit is BookCandidate => hit !== null)
}

/**
 * The scan path (`SPEC §9`). One call, keyed by ISBN.
 *
 * The response shape is **not** the search shape, and every difference below was read
 * off the live API on 2026-08-21 rather than from the docs:
 *
 * - The body is an object keyed by the literal string `ISBN:{isbn13}`. **A missing key
 *   is how "not found" arrives** — there is no 404, and not-found is a normal outcome
 *   rather than an error (`SPEC §9`).
 * - `authors` are objects with a `name`, where search gives plain strings. Real data
 *   repeats them: `9780374533557` lists Daniel Kahneman twice under two author keys.
 * - `cover` carries complete URLs, where search gives a numeric id for `coverUrl()`.
 * - `key` is an edition key, not a work key.
 * - `publish_date` is a string like "April 2, 2013", so `firstPublishYear` stays null
 *   rather than guessing a year for a field nothing currently reads.
 *
 * Returns null for a book Open Library doesn't have. Rate limiting is indistinguishable
 * from that — an empty body has no key either — and both land the caller on the same
 * prefilled form, so the ambiguity costs nothing here.
 */
export async function lookupIsbn(
  isbn13: string,
  signal?: AbortSignal,
): Promise<BookCandidate | null> {
  const url = new URL(LOOKUP_URL)
  url.searchParams.set('bibkeys', `ISBN:${isbn13}`)
  url.searchParams.set('format', 'json')
  url.searchParams.set('jscmd', 'data')

  const response = await fetch(url, { signal: withTimeout(LOOKUP_TIMEOUT_MS, signal) })
  if (!response.ok) {
    throw new Error(`Open Library lookup failed (${response.status})`)
  }

  const body = (await response.json()) as Record<string, LookupRecord | undefined>
  const record = body[`ISBN:${isbn13}`]
  if (!record?.title) return null

  return {
    openLibraryKey: record.key ?? null,
    title: record.title,
    // Deduplicated: real records repeat an author under two keys.
    authors: [
      ...new Set(
        (record.authors ?? [])
          .map((author) => author.name)
          .filter((name): name is string => Boolean(name)),
      ),
    ],
    coverUrl: record.cover?.medium ?? null,
    firstPublishYear: null,
    isbn13,
  }
}
