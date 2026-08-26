import {
  ArrowLeftRight,
  Keyboard,
  Library,
  Plus,
  Search as SearchIcon,
  Settings as SettingsIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import { AddBookSheet } from '@/components/AddBookSheet'
import { BookCover } from '@/components/BookCover'
import { BookSwitcher } from '@/components/BookSwitcher'
import { ChapterStepper } from '@/components/ChapterStepper'
import { InstallCard } from '@/components/InstallCard'
import { Mark } from '@/components/Mark'
import { NoteList } from '@/components/NoteList'
import { QueueCard } from '@/components/QueueCard'
import { RecordButton } from '@/components/RecordButton'
import { TypeNoteSheet } from '@/components/TypeNoteSheet'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useBookNotes, useBooks, useFailedNotes, useLiveNotes } from '@/hooks/useLibrary'
import { useScannedDraft } from '@/hooks/useScannedDraft'
import { usingEmulators } from '@/lib/firebase'
import { isRecordingSupported } from '@/lib/recorder'
import { useAuth } from '@/stores/auth'
import { initCapture, useCapture } from '@/stores/capture'
import { resolveSelected, useLibrary } from '@/stores/library'

/** Enough to see the note you just made land, not enough to start reading here. */
const RECENT_LIMIT = 3

/**
 * The one screen that matters on a phone: current book, current chapter, big button.
 * Opens ready to record (SPEC §8).
 */
export function Now() {
  const user = useAuth((s) => s.user)
  const uid = user?.uid ?? null

  const books = useBooks(uid)
  /**
   * Cross-book and capped at 50, and it stays that way because it feeds the `QueueCard`
   * alone. What is in flight is recent by definition, so a cap is right for it — and
   * wrong for the feed below, which is neither cross-book nor bounded to the recent.
   */
  const notes = useLiveNotes(uid)
  const failed = useFailedNotes(uid)

  const selectedBookId = useLibrary((s) => s.selectedBookId)
  const select = useLibrary((s) => s.select)
  const book = resolveSelected(books, selectedBookId)

  /**
   * This book's notes, all of them — deliberately *not* `notes` filtered by `bookId`.
   * That feed is the newest 50 across every book, so filtering it would return nothing
   * for a book you last recorded against fifty notes ago and print "no notes on this
   * book yet" over a book with two hundred. Same reason `useFailedNotes` is its own
   * subscription: a list that quietly stops listing is worse than no list.
   */
  const bookNotes = useBookNotes(uid, book?.id ?? null)

  const [switching, setSwitching] = useState(false)
  const [addingBook, setAddingBook] = useState(false)
  /**
   * Set when **Add a book** is tapped inside the switcher, and spent when the switcher
   * reports that it has finished closing. The two sheets are never mounted at the same
   * time — see `BookSwitcher`'s `onClosed`.
   */
  const [addAfterSwitcher, setAddAfterSwitcher] = useState(false)
  const scanned = useScannedDraft()
  const [typingNote, setTypingNote] = useState(false)

  const status = useCapture((s) => s.status)
  const elapsedMs = useCapture((s) => s.elapsedMs)
  const queuedCount = useCapture((s) => s.queuedCount)
  const error = useCapture((s) => s.error)
  const lastAutoStop = useCapture((s) => s.lastAutoStop)
  const toggle = useCapture((s) => s.toggle)

  const supported = useMemo(() => isRecordingSupported(), [])

  /**
   * Newest first and just a few — this is the "did it land" glance, not a reading
   * surface. `useBookNotes` returns them in *reading* order (chapter, then time), which
   * is right for the Book screen and backwards here, so they are re-sorted in memory.
   */
  const recent = useMemo(
    () =>
      [...bookNotes]
        .sort((a, b) => (b.recordedAt?.toMillis() ?? 0) - (a.recordedAt?.toMillis() ?? 0))
        .slice(0, RECENT_LIMIT),
    [bookNotes],
  )

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
          {/* The book this note will be filed under — the first of the three things this
              screen owes you, and the one a strip of four covers used to answer only by
              implication.

              Plain text with an explicit **Switch**, never a tappable block: this is
              ADR-024's rule one level up. A block that changed the book on touch would
              put "file this under something else" a mis-tap away, on the screen where a
              mis-tap costs the most. */}
          {uid && book ? (
            <div className="flex items-center gap-3">
              <BookCover
                title={book.title}
                coverUrl={book.coverUrl}
                className="w-14 shrink-0"
              />

              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 leading-tight font-medium">{book.title}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {book.authors.join(', ') || 'Unknown author'}
                </p>
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setSwitching(true)}
                className="shrink-0"
              >
                <ArrowLeftRight className="h-3.5 w-3.5" />
                Switch
              </Button>
            </div>
          ) : null}

          {uid && book ? <ChapterStepper uid={uid} book={book} /> : null}

          {/* Nothing to file a note under yet. The shelf is the whole prerequisite for
              capture, so this replaces the record button rather than sitting beside a
              disabled one. */}
          {books.length === 0 ? (
            /* No book to name and nothing to switch between, so the header above renders
               nothing and the add affordance the strip used to carry lives here instead. */
            <div className="flex flex-col items-center gap-3 py-4">
              <p className="text-muted-foreground text-center text-sm">
                Add the book you&rsquo;re reading and the record button appears.
              </p>
              <Button variant="outline" onClick={() => setAddingBook(true)}>
                <Plus className="h-4 w-4" />
                Add a book
              </Button>
            </div>
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

      {/* This book's notes, not today's across every book. Reading back belongs to the
          Book screen and finding to Search; what this owes is the third thing the screen
          owes — confirmation that what you just said landed, with its text in it. */}
      {book ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent notes</CardTitle>
            {/*
              N comes from `bookNotes`, never from `book.noteCount`. The two disagree in
              exactly the window this card has to survive: `noteCount` is an `increment`,
              which Firestore applies to the local cache at once, while the subscription
              returns `[]` until its snapshot lands — so the pair would render "No notes
              on this book yet." directly beneath "All 12 notes". One source, and the
              link simply isn't there until there is something to link to.
            */}
            {bookNotes.length > 0 ? (
              <CardAction>
                <Button variant="link" asChild className="h-auto p-0 text-xs">
                  <Link to={`/books/${book.id}`}>
                    All {bookNotes.length} note{bookNotes.length === 1 ? '' : 's'}
                  </Link>
                </Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent>
            {/* Without this the default reads "No notes yet. Tap the button and say
                something." — which asserts the book is empty at the one moment we cannot
                know it, before the subscription has delivered. */}
            {/* `book` is what lets each row name its chapter rather than only number it. */}
            <NoteList notes={recent} book={book} empty="No notes on this book yet." />
          </CardContent>
        </Card>
      ) : null}

      {usingEmulators ? (
        <p className="text-muted-foreground mt-auto text-center text-xs">
          Running against Firebase emulators ·{' '}
          <code className="text-xs">demo-marginalia</code>
        </p>
      ) : null}

      {uid ? (
        <BookSwitcher
          books={books}
          selectedId={book?.id ?? null}
          open={switching}
          onOpenChange={setSwitching}
          onSelect={(bookId) => {
            select(bookId)
            setSwitching(false)
          }}
          // Closes this sheet and *only* that. The add sheet is opened from `onClosed`
          // below, so the two are never mounted together.
          onAdd={() => {
            setAddAfterSwitcher(true)
            setSwitching(false)
          }}
          onClosed={() => {
            if (!addAfterSwitcher) return
            setAddAfterSwitcher(false)
            setAddingBook(true)
          }}
        />
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
