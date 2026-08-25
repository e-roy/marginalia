import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  PencilLine,
  RotateCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { StatusLine } from '@/components/NoteList'
import { ReadingScreen } from '@/components/ReadingScreen'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useNote } from '@/hooks/useLibrary'
import { formatClockTime, formatDuration, formatNoteDate } from '@/lib/format'
import {
  deleteNote,
  moveNoteToChapter,
  repolishNote,
  retryNote,
  updateNoteText,
} from '@/lib/notes'
import { useAuth } from '@/stores/auth'

/**
 * Grow a textarea to its content.
 *
 * `height: auto` first, so shrinking works as well as growing — `scrollHeight` on an
 * already-tall element only ever reports the taller number. Deliberately not
 * `field-sizing: content`, which would be four fewer lines but cannot be assumed on
 * Safari, and Safari is what this app is for.
 */
function resize(element: HTMLTextAreaElement) {
  element.style.height = 'auto'
  element.style.height = `${element.scrollHeight}px`
}

/**
 * One note (`SPEC §8`): the cleaned-up text, the verbatim transcript beside it, a
 * re-polish, an in-place edit, the chapter it is filed under, and delete.
 *
 * Editing and moving arrived in M7 and are the two that interact: an edit sets
 * `edited: true`, which is what withdraws **Re-polish** here and refuses it server-side
 * ([[Decisions/Decision Log#ADR-012]]).
 */

/**
 * The callable's own messages are written for a human and sanitized server-side
 * (ADR-002), so they are shown as they arrive. Two cases are not its messages: a
 * client-side deadline, where the function is still working and the text will land on
 * its own, and anything else, which is a transport failure with nothing useful to say.
 */
function repolishMessage(err: unknown): string {
  const fault = err as { code?: unknown; message?: unknown } | null

  if (fault?.code === 'functions/deadline-exceeded') {
    return 'Cleanup is taking a while. It will appear here when it finishes.'
  }

  const message = fault?.message
  if (typeof message === 'string' && message.trim().length > 0 && message !== 'internal') {
    return message
  }
  return 'Could not clean up this note.'
}

export function Note() {
  const { noteId = null } = useParams()
  const uid = useAuth((s) => s.user?.uid ?? null)
  const { note, loading } = useNote(uid, noteId)

  const [showRaw, setShowRaw] = useState(false)
  const [editing, setEditing] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deletedFrom, setDeletedFrom] = useState<string | null>(null)

  // A ref callback rather than an effect: it fires when the textarea mounts, which is the
  // one moment the initial height needs setting.
  const grow = useCallback((element: HTMLTextAreaElement | null) => {
    if (element) resize(element)
  }, [])

  // Disarm on its own. A stray tap should not leave a destructive button primed for the
  // rest of the time this screen is open.
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])

  if (!uid) return <Navigate to="/" replace />
  // Before the `!note` guard below, which would otherwise win the race with the
  // snapshot and send a just-deleted note to the Now screen instead of its book.
  if (deletedFrom) return <Navigate to={`/books/${deletedFrom}`} replace />
  // Waiting on the subscription, not a missing note — telling them apart is the whole
  // reason `useNote` reports `loading` separately.
  if (loading) return null
  if (!note) return <Navigate to="/" replace />

  const noteDate = formatNoteDate(note.recordedAt)
  const raw = note.rawText
  const clean = note.cleanText

  // Nothing to toggle between when the polish never ran, or
  // for a typed note, where both fields hold the same string by construction.
  const comparable = Boolean(raw && clean && raw !== clean)
  const body = showRaw ? raw : (clean ?? raw)

  // The same conditions `repolishNote` enforces server-side, so the button is never
  // offered for a call that would be refused.
  const canRepolish =
    note.source === 'voice' &&
    note.status === 'done' &&
    !note.edited &&
    (raw ?? '').trim().length > 0

  /**
   * A note that gave up is worth retrying only while its recording is still there.
   * Attempt exhaustion keeps the audio — the Mac Mini being asleep says nothing about
   * the recording — while a rejected or over-long file has already been deleted, and
   * so has anything the bucket lifecycle rule has since reclaimed. `StatusLine` says
   * so in words when this is false.
   */
  const canRetry = note.status === 'failed' && note.audioPath !== null

  /**
   * Editing is for a finished note with text you can see. A note still transcribing has
   * nothing to correct yet, and the raw pane is the transcript — writing that into
   * `cleanText` would throw the polish away without saying so.
   */
  const canEdit = note.status === 'done' && Boolean(body) && !showRaw

  /**
   * Both writes are `void`-ed with a `.catch`, never awaited — a stated position rather
   * than the house default.
   *
   * Awaiting would hang the screen offline: `notes.ts` records that a Firestore write
   * resolves only once the server acks it, so a saving spinner would spin all the way
   * home from the train. A bare `void` is the opposite failure — blur has already put the
   * `<p>` back, so a rejected write would drop the correction silently. The local cache
   * applies the write synchronously and `onSnapshot` re-renders with it either way, so
   * what the `.catch` actually catches is the class that has nothing to do with
   * connectivity: rules and validation.
   */
  const commitEdit = (value: string) => {
    setEditing(false)
    if (!noteId) return

    const next = value.trim()
    // Nothing typed, or nothing changed. An empty note is a deletion, and the Delete
    // button is right there — blanking the textarea should not be a second way to do it.
    if (next.length === 0 || next === body) return

    void updateNoteText(uid, noteId, next).catch((err: unknown) => {
      console.error('[marginalia] edit failed', err)
      toast.error('Could not save your edit.')
    })
  }

  /** Below chapter 1 is Unfiled, exactly as the capture stepper has it (`SPEC §8`). */
  const move = (delta: number) => {
    if (!noteId) return
    const from = note.chapter
    const stepped = from === null ? (delta > 0 ? 1 : null) : from + delta
    const next = stepped !== null && stepped < 1 ? null : stepped
    if (next === from) return

    void moveNoteToChapter(uid, noteId, next).catch((err: unknown) => {
      console.error('[marginalia] move chapter failed', err)
      toast.error('Could not move this note.')
    })
  }

  const retry = async () => {
    if (!noteId) return
    setRetrying(true)
    try {
      await retryNote(uid, noteId)
      // Nothing to await beyond the write: the sweep runs every five minutes and the
      // transcript arrives through onSnapshot whenever it lands.
      toast.success('Back in the queue. It will be transcribed within a few minutes.')
    } catch (err) {
      console.error('[marginalia] retry failed', err)
      toast.error("Couldn't put this note back in the queue.")
    } finally {
      setRetrying(false)
    }
  }

  const repolish = async () => {
    if (!noteId) return
    setPolishing(true)
    try {
      await repolishNote(noteId)
      // The text itself arrives through onSnapshot. Drop back to the clean pane so the
      // result is what's on screen rather than the transcript it was made from.
      setShowRaw(false)
      toast.success('Cleaned up.')
    } catch (err) {
      console.error('[marginalia] repolish failed', err)
      toast.error(repolishMessage(err))
    } finally {
      setPolishing(false)
    }
  }

  const remove = async () => {
    if (!noteId) return
    setDeleting(true)
    try {
      // Set *before* awaiting. Firestore applies the delete to the local cache
      // immediately, so `onSnapshot` reports the note gone while `deleteNote` is still
      // resolving — and the `!note` guard would send us to the Now screen first.
      setDeletedFrom(note.bookId)
      await deleteNote(uid, noteId, note.bookId)
      toast.success('Note deleted.')
    } catch (err) {
      // Already back on the book screen by now, with the note still in its chapter.
      // The toast is what says so.
      console.error('[marginalia] delete failed', err)
      toast.error('Could not delete this note.')
      setDeletedFrom(null)
      setConfirming(false)
      setDeleting(false)
    }
  }

  return (
    <ReadingScreen>
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link to={`/books/${note.bookId}`}>
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <h1 className="line-clamp-1 flex-1 text-sm font-semibold">{note.bookTitle}</h1>
      </header>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {/* A note is reachable by URL forever, so on this screen above all a time with no
            day attached names nothing. Omitted only when it is today. */}
        {noteDate ? (
          <>
            <span>{noteDate}</span>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <span className="tabular-nums">{formatClockTime(note.recordedAt)}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{formatDuration(note.durationMs)}</span>
        <span aria-hidden>·</span>

        {/* Stepping, not picking, and below chapter 1 is Unfiled — the same semantics
            `ChapterStepper` uses on the Now screen, against `note.chapter` instead of
            `book.currentChapter`. Copied rather than shared: the two write different
            documents, and the shape is four lines. */}
        <span className="inline-flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="Move to the previous chapter"
            onClick={() => move(-1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="min-w-20 text-center tabular-nums">
            {note.chapter === null ? 'Unfiled' : `Chapter ${note.chapter}`}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label="Move to the next chapter"
            onClick={() => move(1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </span>

        {/* Says why Re-polish vanished. Without it the button's absence reads as a bug
            rather than as the note being yours now (ADR-012). */}
        {note.edited ? (
          <>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <PencilLine className="h-3 w-3" />
              Edited
            </span>
          </>
        ) : null}
      </div>

      {/* The LLM's 5-8 word summary. Absent for a typed note, and for any voice note
          whose polish was skipped or rejected. */}
      {note.title ? <h2 className="text-lg leading-snug font-semibold">{note.title}</h2> : null}

      {note.status === 'done' && body ? (
        editing ? (
          /* Uncontrolled — `defaultValue` plus commit-on-blur, the same idiom as the book
             title and the chapter title. A controlled textarea would race the `onSnapshot`
             that its own write triggers, and this app has already paid for that once with
             the add-book author field that ate spaces. */
          <Textarea
            autoFocus
            defaultValue={body}
            ref={grow}
            onInput={(event) => resize(event.currentTarget)}
            onBlur={(event) => commitEdit(event.target.value)}
            onKeyDown={(event) => {
              // Escape reverts. Enter deliberately does not commit — a note is prose and
              // needs its newlines, so the only way out is blur or Escape.
              if (event.key === 'Escape') setEditing(false)
            }}
            aria-label="Note text"
            className="resize-none overflow-hidden text-sm leading-relaxed"
          />
        ) : (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{body}</p>
        )
      ) : (
        <StatusLine note={note} withActions />
      )}

      {comparable || canRepolish || canRetry || canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* First, because on a failed note it is the only thing worth doing. */}
          {canRetry ? (
            <Button variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>
              {retrying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              Try again
            </Button>
          ) : null}

          {/* Hidden while the raw pane is showing: editing there would write the
              transcript into `cleanText` and quietly discard the polish. */}
          {canEdit && !editing ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <PencilLine className="h-3.5 w-3.5" />
              Edit
            </Button>
          ) : null}

          {comparable ? (
            <Button variant="outline" size="sm" onClick={() => setShowRaw(!showRaw)}>
              {showRaw ? 'Show cleaned up' : 'Show original'}
            </Button>
          ) : null}

          {canRepolish ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={polishing}
              onClick={() => void repolish()}
              className="text-muted-foreground"
            >
              {polishing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Re-polish
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Two taps rather than a dialog: on a phone this is one thumb and no portal, and
          the arming resets itself after a few seconds. */}
      <Button
        variant="ghost"
        size="sm"
        disabled={deleting}
        onClick={() => (confirming ? void remove() : setConfirming(true))}
        className={`mt-auto self-start ${confirming ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {deleting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
        {confirming ? 'Tap again to delete' : 'Delete'}
      </Button>

      {/* Which models actually ran, recorded after the fact rather than predicted — the
          only honest way to show an auto-pick (see `ServerCard`). */}
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t pt-4 text-xs">
        <dt>Transcription</dt>
        <dd className="truncate font-mono">{note.sttModel ?? '—'}</dd>
        <dt>Cleanup</dt>
        <dd className="truncate font-mono">{note.llmModel ?? 'not cleaned up'}</dd>
      </dl>
    </ReadingScreen>
  )
}
