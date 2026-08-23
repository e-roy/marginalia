import { ChevronLeft, Loader2, RotateCw, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { StatusLine } from '@/components/NoteList'
import { Button } from '@/components/ui/button'
import { useNote } from '@/hooks/useLibrary'
import { formatClockTime, formatDuration } from '@/lib/format'
import { deleteNote, repolishNote, retryNote } from '@/lib/notes'
import { useAuth } from '@/stores/auth'

/**
 * One note (`SPEC §8`). What M4 needs it for: seeing the cleaned-up text, comparing it
 * against the verbatim transcript, and re-running the polish.
 *
 * Editing, moving a note between chapters, and deleting are deliberately not here yet —
 * inline editing is M7, and the other two are unassigned.
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
  const [polishing, setPolishing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deletedFrom, setDeletedFrom] = useState<string | null>(null)

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
    <div className="mx-auto flex min-h-[var(--app-height)] w-full max-w-md flex-col gap-5 px-5 py-6">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link to={`/books/${note.bookId}`}>
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <h1 className="line-clamp-1 flex-1 text-sm font-semibold">{note.bookTitle}</h1>
      </header>

      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <span className="tabular-nums">{formatClockTime(note.recordedAt)}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{formatDuration(note.durationMs)}</span>
        <span aria-hidden>·</span>
        <span>{note.chapter === null ? 'Unfiled' : `Chapter ${note.chapter}`}</span>
      </div>

      {/* The LLM's 5-8 word summary. Absent for a typed note, and for any voice note
          whose polish was skipped or rejected. */}
      {note.title ? <h2 className="text-lg leading-snug font-semibold">{note.title}</h2> : null}

      {note.status === 'done' && body ? (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{body}</p>
      ) : (
        <StatusLine note={note} withActions />
      )}

      {comparable || canRepolish || canRetry ? (
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
    </div>
  )
}
