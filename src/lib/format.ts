import type { Timestamp } from 'firebase/firestore'

/** `7:04` — the recording timer. Minutes never pad, seconds always do. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** `0:42` for a note's length, or an em dash when there isn't one (typed notes). */
export function formatDuration(ms: number | null): string {
  return ms === null ? '—' : formatElapsed(ms)
}

/**
 * A Timestamp written with `serverTimestamp()` reads back null until the server acks
 * it, so every caller has to cope with the gap. `recordedAt` is a client Timestamp
 * precisely so the feed can sort and label a note the instant it exists.
 */
export function formatClockTime(value: Timestamp | null): string {
  if (!value) return '—'
  return value.toDate().toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * `4m` / `30s` — how long until a queued retry is due.
 *
 * Coarse on purpose. This is a reassurance that something is scheduled, not a
 * countdown worth watching, and the sweep runs on a five-minute tick anyway so
 * second-level precision would be false. Returns null once the time has passed, which
 * the caller reads as "any moment now".
 */
export function formatCountdown(value: Timestamp | null, nowMs = Date.now()): string | null {
  if (!value) return null
  const ms = value.toMillis() - nowMs
  if (ms <= 0) return null
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  return `${Math.round(ms / 60_000)}m`
}

/**
 * `Aug 14`, or `Aug 14, 2025` when it is not this year — and **null when it is today**.
 *
 * Null rather than a string, because "today" is the one case where a date is noise: the
 * Now screen's feed is filtered to today by construction, so every row there would carry
 * the same redundant word. Everywhere else — a book's notes, a search result, a note you
 * opened by URL — a bare `9:41 AM` names a moment without saying which day, which is no
 * use at all on a note from three weeks ago.
 *
 * Locale-formatted, unlike the export's `YYYY-MM-DD` (`markdown.ts`): this is read on
 * screen by one person, where a Markdown file is a durable artifact that must not change
 * shape with the browser it was written in.
 */
export function formatNoteDate(value: Timestamp | null, nowMs = Date.now()): string | null {
  if (!value || isToday(value)) return null

  const date = value.toDate()
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear()

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/**
 * The DOM id a chapter's section carries, and what the desktop chapter index links to.
 *
 * `chapter-unfiled` rather than `chapter-null`, matching the `key` the Book screen has
 * always used for the same group (`group.chapter ?? 'unfiled'`). Shared from here so the
 * index and the section cannot spell it differently — a link that silently scrolls
 * nowhere is the kind of bug nobody files.
 */
export function chapterAnchor(chapter: number | null): string {
  return `chapter-${chapter ?? 'unfiled'}`
}

export function isToday(value: Timestamp | null): boolean {
  if (!value) return true // an unacked write is, by definition, from just now
  const date = value.toDate()
  const now = new Date()
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

/**
 * `2020 · 256 pages · Harriman House` — a book's publication details on one line, skipping
 * whatever Open Library did not have, and null when it had none of it.
 *
 * Shared because it is rendered in two places over two different shapes — the add-book
 * sheet's `Draft` and the details screen's `Book` — and two copies of a display rule are two
 * chances for the same book to read differently on consecutive screens.
 */
export function formatPublication(
  publishYear: number | null,
  pageCount: number | null,
  publisher: string | null,
): string | null {
  const parts = [
    publishYear === null ? null : String(publishYear),
    pageCount === null ? null : `${pageCount} page${pageCount === 1 ? '' : 's'}`,
    publisher,
  ].filter((part): part is string => Boolean(part))

  return parts.length > 0 ? parts.join(' · ') : null
}
