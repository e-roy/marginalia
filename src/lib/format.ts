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
