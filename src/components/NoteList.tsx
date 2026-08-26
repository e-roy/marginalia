import { AlertTriangle, CloudOff, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'

import { Highlighted } from '@/components/Highlighted'
import { chapterHeading } from '@/lib/books'
import { formatClockTime, formatDuration, formatNoteDate } from '@/lib/format'
import { noteText, type Book, type NoteStatus, type NoteWithId } from '@/lib/types'

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

/**
 * Exported because the Note screen shows the same states for the same reasons.
 *
 * `withActions` is set there and only there: that screen renders Try again directly
 * below this line, so pointing at a button the reader can already see would be noise.
 * In the feed there is no button, so the line has to say where to find one.
 */
export function StatusLine({
  note,
  withActions = false,
}: {
  note: NoteWithId
  withActions?: boolean
}) {
  // A finished note with nothing in it means Whisper heard no speech — a pocket
  // recording, or a tap that caught silence. Saying so beats an empty row.
  if (note.status === 'done') {
    return <p className="text-muted-foreground text-sm italic">No speech in this recording.</p>
  }

  // A retry keeps the previous attempt's error until it succeeds, so while the
  // function is actively working, "Transcribing…" is the truer thing to show.
  if (note.status === 'failed' || (note.error && note.status !== 'transcribing')) {
    /**
     * What happens next, which the error itself deliberately does not say.
     *
     * The same code means three different futures depending on where the note is. Still
     * `pending` — the sweep will come back to it. `failed` with its audio — it gave up,
     * and Try again on the Note screen will put it back in the queue. `failed` without
     * — the recording is gone (rejected outright, or reclaimed by the bucket lifecycle
     * rule) and nothing can bring the transcript back.
     */
    const outcome =
      note.status !== 'failed'
        ? ' This will retry on its own.'
        : note.audioPath !== null
          ? withActions
            ? ''
            : ' Open the note and tap Try again.'
          : ' The recording is no longer available.'

    return (
      <p className="text-destructive flex items-start gap-1.5 text-sm">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {/* Sanitized server-side — never a raw fetch error, never a hostname. */}
        <span>
          {note.error?.message ?? 'Transcription failed.'}
          <span className="text-muted-foreground">{outcome}</span>
        </span>
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
  /**
   * The book these notes belong to, when they all belong to one — which lets the chapter
   * line carry the chapter's *name* rather than only its number. Omitted by the search
   * screen, where the rows span books and there is no single one to name.
   */
  book?: Pick<Book, 'chapterTitles' | 'tableOfContents'>
  /** Search terms to mark up, when the list is showing filtered results. */
  terms?: string[]
  /** Replaces the "no notes yet" prompt when a filter is what emptied the list. */
  empty?: string
}

export function NoteList({ notes, showChapter = true, terms = [], empty, book }: NoteListProps) {
  if (notes.length === 0) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        {empty ?? 'No notes yet. Tap the button and say something.'}
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-4">
      {notes.map((note) => {
        const text = noteText(note)
        // Absent when the note is from today, which is the only case where naming the day
        // adds nothing — see `formatNoteDate`.
        const date = formatNoteDate(note.recordedAt)
        // Null unless the caller said which book these are, and unless that book has a
        // name for this chapter either way.
        const heading = book ? chapterHeading(book, note.chapter) : null

        return (
          <li key={note.id} className="border-border/60 border-b last:border-0">
            {/* The whole row is the target — on a phone, a tappable line of prose is
                easier to hit than any affordance that would fit beside it. */}
            <Link
              to={`/notes/${note.id}`}
              className="hover:bg-accent/40 -mx-2 flex flex-col gap-1 rounded-md px-2 py-1 pb-4 transition-colors"
            >
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                {date ? (
                  <>
                    <span>{date}</span>
                    <span aria-hidden>·</span>
                  </>
                ) : null}
                <span className="tabular-nums">{formatClockTime(note.recordedAt)}</span>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{formatDuration(note.durationMs)}</span>
                {showChapter ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>
                      {note.chapter === null ? 'Unfiled' : `Chapter ${note.chapter}`}
                      {/* The chapter's name when we know it — the reader's own title, or
                          the printed contents (ADR-026). Only when the list belongs to a
                          single book; across books there is nothing to look it up in. */}
                      {heading ? <span className="italic"> · {heading.title}</span> : null}
                    </span>
                  </>
                ) : null}
              </div>

              {note.status === 'done' && text ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  <Highlighted text={text} terms={terms} />
                </p>
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
