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
const COVERS_URL = 'https://covers.openlibrary.org/b/id'

/** What the shelf needs from a search hit, already flattened out of the API shape. */
export interface BookCandidate {
  /** Open Library work key, e.g. `/works/OL45804W`. Null when the hit has none. */
  openLibraryKey: string | null
  title: string
  authors: string[]
  coverUrl: string | null
  firstPublishYear: number | null
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
  }
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
    response = await fetch(url, { signal })
  } catch (err) {
    if (signal?.aborted) return []
    throw err
  }

  if (!response.ok) {
    throw new Error(`Open Library search failed (${response.status})`)
  }

  const body = (await response.json()) as { docs?: SearchDoc[] }
  return (body.docs ?? []).map(toCandidate).filter((hit): hit is BookCandidate => hit !== null)
}
