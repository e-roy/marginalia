import { AlertTriangle, Clock, CloudOff, Loader2 } from 'lucide-react'
import type { Timestamp } from 'firebase/firestore'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { formatCountdown } from '@/lib/format'
import type { NoteWithId } from '@/lib/types'

/**
 * What is in flight, and when the next thing will happen.
 *
 * Before M6 the Now screen said only how many recordings were waiting to upload, and
 * everything after that point was invisible unless you opened each note — a note stuck
 * for an hour looked exactly like one uploaded a second ago. The line that earns this
 * component is the countdown: `retrySweep` runs on a five-minute tick, so "waiting on
 * the speech server" is a fact with a *time* attached, and showing it is the difference
 * between "something is wrong" and "it is handled".
 *
 * Renders nothing at all when there is nothing to say, which is the normal case.
 */

interface QueueCardProps {
  /** Recordings still on the device, from the capture store. */
  queuedCount: number
  /** The live feed — capped at 50, which is fine: anything in flight is recent. */
  notes: NoteWithId[]
  /** Its own uncapped subscription, because a note that gave up is not recent. */
  failed: NoteWithId[]
}

function Row({
  icon,
  children,
}: {
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <li className="text-muted-foreground flex items-center gap-2 text-xs">
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  )
}

export function QueueCard({ queuedCount, notes, failed }: QueueCardProps) {
  const pending = notes.filter((note) => note.status === 'pending')
  const transcribing = notes.filter((note) => note.status === 'transcribing')

  /**
   * A countdown has to re-render to count down. One tick a minute matches the coarsest
   * unit `formatCountdown` prints, so nothing is ever more than a minute stale and the
   * phone is not woken for a number that did not change.
   */
  const [, setTick] = useState(0)
  useEffect(() => {
    if (pending.length === 0) return
    const timer = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(timer)
  }, [pending.length])

  if (queuedCount === 0 && pending.length === 0 && transcribing.length === 0 && failed.length === 0) {
    return null
  }

  /**
   * The soonest retry across everything waiting — one number is more use than a list.
   * Compared as milliseconds and formatted once at the end; picking the minimum of the
   * *formatted* strings would put "30s" after "4m".
   */
  const soonest = pending.reduce<Timestamp | null>((best, note) => {
    const due = note.nextAttemptAt
    if (!due) return best
    return best === null || due.toMillis() < best.toMillis() ? due : best
  }, null)
  const nextDue = formatCountdown(soonest)

  // Bound rather than indexed inline, so the link is typed as present rather than
  // asserted — `noUncheckedIndexedAccess` is on.
  const firstFailed = failed[0]

  return (
    <ul className="border-border/60 flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
      {queuedCount > 0 ? (
        <Row icon={<CloudOff className="h-3.5 w-3.5" />}>
          {queuedCount} recording{queuedCount === 1 ? '' : 's'} waiting to upload
        </Row>
      ) : null}

      {pending.length > 0 ? (
        <Row icon={<Clock className="h-3.5 w-3.5" />}>
          {pending.length} waiting on the speech server
          {/* The whole point of the card. Absent when a retry is already due. */}
          {nextDue ? <> · next try in {nextDue}</> : <> · trying shortly</>}
        </Row>
      ) : null}

      {transcribing.length > 0 ? (
        <Row icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />}>
          {transcribing.length} transcribing
        </Row>
      ) : null}

      {firstFailed ? (
        <Row icon={<AlertTriangle className="text-destructive h-3.5 w-3.5" />}>
          {/* Straight to the first one — Try again lives on the note, not here. */}
          <Link to={`/notes/${firstFailed.id}`} className="underline underline-offset-2">
            {failed.length} note{failed.length === 1 ? '' : 's'} gave up
          </Link>
        </Row>
      ) : null}
    </ul>
  )
}
