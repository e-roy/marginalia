import { Keyboard, Library, Search as SearchIcon, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import { AddBookSheet } from '@/components/AddBookSheet'
import { BookStrip } from '@/components/BookStrip'
import { ChapterStepper } from '@/components/ChapterStepper'
import { InstallCard } from '@/components/InstallCard'
import { Mark } from '@/components/Mark'
import { NoteList } from '@/components/NoteList'
import { QueueCard } from '@/components/QueueCard'
import { RecordButton } from '@/components/RecordButton'
import { TypeNoteSheet } from '@/components/TypeNoteSheet'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useBooks, useFailedNotes, useLiveNotes } from '@/hooks/useLibrary'
import { useScannedDraft } from '@/hooks/useScannedDraft'
import { usingEmulators } from '@/lib/firebase'
import { isToday } from '@/lib/format'
import { isRecordingSupported } from '@/lib/recorder'
import { useAuth } from '@/stores/auth'
import { initCapture, useCapture } from '@/stores/capture'
import { resolveSelected, useLibrary } from '@/stores/library'

/**
 * The one screen that matters on a phone: current book, current chapter, big button.
 * Opens ready to record (SPEC §8).
 */
export function Now() {
  const user = useAuth((s) => s.user)
  const uid = user?.uid ?? null

  const books = useBooks(uid)
  const notes = useLiveNotes(uid)
  const failed = useFailedNotes(uid)

  const selectedBookId = useLibrary((s) => s.selectedBookId)
  const select = useLibrary((s) => s.select)
  const book = resolveSelected(books, selectedBookId)

  const [addingBook, setAddingBook] = useState(false)
  const scanned = useScannedDraft()
  const [typingNote, setTypingNote] = useState(false)

  const status = useCapture((s) => s.status)
  const elapsedMs = useCapture((s) => s.elapsedMs)
  const queuedCount = useCapture((s) => s.queuedCount)
  const error = useCapture((s) => s.error)
  const lastAutoStop = useCapture((s) => s.lastAutoStop)
  const toggle = useCapture((s) => s.toggle)

  const supported = useMemo(() => isRecordingSupported(), [])
  const today = useMemo(() => notes.filter((note) => isToday(note.recordedAt)), [notes])

  // What a note gets filed under. Rebuilt whenever the book or its chapter changes, so
  // stepping the chapter between recordings files them separately.
  const target = book
    ? { id: book.id, title: book.title, chapter: book.currentChapter }
    : null

  useEffect(() => {
    if (!uid) return
    // Owns the queue-drain triggers for as long as someone is signed in.
    return initCapture(uid)
  }, [uid])

  useEffect(() => {
    if (!error) return
    toast.error(error)
    useCapture.setState({ error: null })
  }, [error])

  useEffect(() => {
    if (lastAutoStop === null) return
    toast.info(
      lastAutoStop === 'cap'
        ? 'Ten-minute limit reached — the note was saved.'
        : 'Recording stopped when the app went to the background. The note was saved.',
    )
    useCapture.setState({ lastAutoStop: null })
  }, [lastAutoStop])

  return (
    <div className="mx-auto flex min-h-[var(--app-height)] w-full max-w-md flex-col gap-5 px-5 py-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Mark className="h-9 w-9 shrink-0" />
          <div className="min-w-0">
            <p className="leading-tight font-semibold">Marginalia</p>
            <p className="text-muted-foreground truncate text-xs">
              {user?.email ?? user?.displayName ?? 'Signed in'}
            </p>
          </div>
        </div>
        <div className="flex items-center">
          <Button variant="ghost" size="icon" asChild aria-label="Search">
            <Link to="/search">
              <SearchIcon className="h-4 w-4" />
            </Link>
          </Button>
          <Button variant="ghost" size="icon" asChild aria-label="Books">
            <Link to="/books">
              <Library className="h-4 w-4" />
            </Link>
          </Button>
          <Button variant="ghost" size="icon" asChild aria-label="Settings">
            <Link to="/settings">
              <SettingsIcon className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </header>

      <InstallCard />

      <Card>
        <CardContent className="flex flex-col gap-5 pt-6">
          {uid ? (
            <BookStrip
              books={books}
              selectedId={book?.id ?? null}
              onSelect={select}
              onAdd={() => setAddingBook(true)}
            />
          ) : null}

          {uid && book ? <ChapterStepper uid={uid} book={book} /> : null}

          {/* Nothing to file a note under yet. The shelf is the whole prerequisite for
              capture, so this replaces the record button rather than sitting beside a
              disabled one. */}
          {books.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              Add the book you&rsquo;re reading and the record button appears.
            </p>
          ) : !supported ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              This browser can&rsquo;t record audio. Open Marginalia in Safari or Chrome.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <RecordButton
                status={status}
                elapsedMs={elapsedMs}
                disabled={!uid || !target}
                onToggle={() => {
                  if (!uid || !target) return
                  void toggle(uid, target)
                }}
              />

              <Button
                variant="ghost"
                size="sm"
                disabled={status !== 'idle'}
                onClick={() => setTypingNote(true)}
                className="text-muted-foreground mx-auto"
              >
                <Keyboard className="h-3.5 w-3.5" />
                type instead
              </Button>
            </div>
          )}

          {/* Replaces the bare queued count: what is in flight, and when the next
              retry is due. Renders nothing when there is nothing to say. */}
          <QueueCard queuedCount={queuedCount} notes={notes} failed={failed} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Today</CardTitle>
        </CardHeader>
        <CardContent>
          <NoteList notes={today} />
        </CardContent>
      </Card>

      {usingEmulators ? (
        <p className="text-muted-foreground mt-auto text-center text-xs">
          Running against Firebase emulators ·{' '}
          <code className="text-xs">demo-marginalia</code>
        </p>
      ) : null}

      {uid ? (
        <AddBookSheet
          key={scanned.key}
          uid={uid}
          initialDraft={scanned.draft}
          // A returning scan opens the sheet on its own — the user already asked for
          // this by scanning, and the tap that would otherwise open it happened on the
          // previous screen.
          open={addingBook || scanned.draft !== null}
          onOpenChange={(next) => {
            setAddingBook(next)
            if (!next) scanned.clear()
          }}
          onAdded={select}
        />
      ) : null}

      {uid && target ? (
        <TypeNoteSheet
          uid={uid}
          target={target}
          open={typingNote}
          onOpenChange={setTypingNote}
        />
      ) : null}
    </div>
  )
}
