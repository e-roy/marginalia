import { AlertTriangle, CloudOff, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'

import { formatClockTime, formatDuration } from '@/lib/format'
import { noteText, type NoteStatus, type NoteWithId } from '@/lib/types'

/**
 * What each status means to someone holding a phone. The user is never left guessing
 * why a note is blank (SPEC §4) — in particular `queued` says exactly what has to
 * happen next, because on iOS nothing will happen until the app is open.
 */
const PENDING_LABELS: Record<Exclude<NoteStatus, 'done' | 'failed'>, string> = {
  queued: 'Waiting to upload — open the app on Wi-Fi',
  pending: 'Uploaded — waiting on the speech server',
  transcribing: 'Transcribing…',
}

/** Exported because the Note screen shows the same states for the same reasons. */
export function StatusLine({ note }: { note: NoteWithId }) {
  // A finished note with nothing in it means Whisper heard no speech — a pocket
  // recording, or a tap that caught silence. Saying so beats an empty row.
  if (note.status === 'done') {
    return <p className="text-muted-foreground text-sm italic">No speech in this recording.</p>
  }

  // A retry keeps the previous attempt's error until it succeeds, so while the
  // function is actively working, "Transcribing…" is the truer thing to show.
  if (note.status === 'failed' || (note.error && note.status !== 'transcribing')) {
    return (
      <p className="text-destructive flex items-start gap-1.5 text-sm">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {/* Sanitized server-side — never a raw fetch error, never a hostname. */}
        <span>{note.error?.message ?? 'Transcription failed.'}</span>
      </p>
    )
  }

  const label = PENDING_LABELS[note.status as Exclude<NoteStatus, 'done' | 'failed'>]

  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
      {note.status === 'queued' ? (
        <CloudOff className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      )}
      {label}
    </p>
  )
}

interface NoteListProps {
  notes: NoteWithId[]
  /** Off on the book screen, where the notes are already grouped under their chapter. */
  showChapter?: boolean
}

export function NoteList({ notes, showChapter = true }: NoteListProps) {
  if (notes.length === 0) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        No notes yet. Tap the button and say something.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-4">
      {notes.map((note) => {
        const text = noteText(note)
        return (
          <li key={note.id} className="border-border/60 border-b last:border-0">
            {/* The whole row is the target — on a phone, a tappable line of prose is
                easier to hit than any affordance that would fit beside it. */}
            <Link
              to={`/notes/${note.id}`}
              className="hover:bg-accent/40 -mx-2 flex flex-col gap-1 rounded-md px-2 py-1 pb-4 transition-colors"
            >
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                <span className="tabular-nums">{formatClockTime(note.recordedAt)}</span>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{formatDuration(note.durationMs)}</span>
                {showChapter ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>{note.chapter === null ? 'Unfiled' : `Chapter ${note.chapter}`}</span>
                  </>
                ) : null}
              </div>

              {note.status === 'done' && text ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
              ) : (
                <StatusLine note={note} />
              )}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
