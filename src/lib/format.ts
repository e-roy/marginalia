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
