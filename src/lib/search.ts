import { noteText, type NoteWithId } from '@/lib/types'

/**
 * Client-side search across every note (`SPEC §8`).
 *
 * Client-side on purpose: Firestore has no full-text search, a reader's lifetime of notes
 * is a few megabytes, and Firestore's persistence has already cached them. Substring
 * matching over a few thousand notes is sub-millisecond, so there is no index to build and
 * nothing to keep in sync.
 */

/** How much of a note to show around the first match. */
const SNIPPET_RADIUS = 120

export interface SearchHit {
  note: NoteWithId
  /** A window around the first match, with `…` where it was cut. */
  snippet: string
}

/**
 * A query is its whitespace-separated words, and **every** one must appear (AND).
 *
 * OR would make a two-word query strictly less useful than a one-word one, which is the
 * opposite of what typing a second word means.
 */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

/**
 * What a note is searched over: exactly what the reader can see.
 *
 * `noteText()` is `cleanText ?? rawText`, so a polished note is matched on its polish. The
 * alternative — searching `rawText` as well — would return notes whose visible text does
 * not contain the term at all, which cannot be highlighted and reads as a bug rather than
 * as a feature.
 */
function haystack(note: NoteWithId): string {
  return [note.title ?? '', note.bookTitle, noteText(note) ?? ''].join('\n').toLowerCase()
}

/**
 * Escape a user's query for use inside a regex.
 *
 * Not optional and not defensive: the highlighter builds one regex out of the terms, so a
 * query containing `(` or `*` throws `Invalid regular expression: Nothing to repeat` and
 * takes the whole screen down. Anyone typing `the heuristic (see *availability*)` — which
 * is to say, anyone pasting a phrase out of their own note — hits it.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function snippetAround(text: string, terms: string[]): string {
  const lower = text.toLowerCase()

  const first = terms
    .map((term) => lower.indexOf(term))
    .filter((at) => at >= 0)
    .sort((a, b) => a - b)[0]

  if (first === undefined || text.length <= SNIPPET_RADIUS * 2) return text

  const start = Math.max(0, first - SNIPPET_RADIUS)
  const end = Math.min(text.length, first + SNIPPET_RADIUS)

  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

export function searchNotes(notes: NoteWithId[], query: string): SearchHit[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return []

  const hits: SearchHit[] = []
  for (const note of notes) {
    const hay = haystack(note)
    if (!terms.every((term) => hay.includes(term))) continue

    const text = noteText(note) ?? ''
    hits.push({ note, snippet: snippetAround(text, terms) })
  }
  return hits
}

/**
 * Split text into alternating plain and matched runs, so the caller can wrap the matches
 * without ever putting user text through `dangerouslySetInnerHTML`.
 *
 * Even indices are plain, odd are matches — the shape `String.split` with a capture group
 * gives, kept rather than converted so a caller can map straight over it.
 */
export function highlightParts(text: string, terms: string[]): string[] {
  if (terms.length === 0) return [text]
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  return text.split(pattern)
}
