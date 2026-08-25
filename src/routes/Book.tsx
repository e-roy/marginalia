import { ChevronLeft, Download, Loader2, Mic, Search as SearchIcon, Trash2 } from 'lucide-react'
import { useDeferredValue, useId, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { BookCover } from '@/components/BookCover'
import { ChapterIndex } from '@/components/ChapterIndex'
import { ChapterNotes } from '@/components/ChapterNotes'
import { ReadingScreen } from '@/components/ReadingScreen'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBook, useBookNotes, useBooks } from '@/hooks/useLibrary'
import { deleteBook, updateBook } from '@/lib/books'
import { downloadBlob } from '@/lib/download'
import { bookExport, hasExportableNotes, MARKDOWN_MIME } from '@/lib/export'
import { queryTerms, searchNotes } from '@/lib/search'
import type { Book as BookDoc, NoteWithId } from '@/lib/types'
import { useAuth } from '@/stores/auth'
import { useLibrary } from '@/stores/library'

const STATUSES: { status: BookDoc['status']; label: string }[] = [
  { status: 'reading', label: 'Reading' },
  { status: 'finished', label: 'Finished' },
  { status: 'shelved', label: 'Shelved' },
]

/**
 * Notes in chapter order, which is reading order — not the order they were captured
 * in. `null` is Unfiled and comes first, matching how Firestore already sorts it.
 */
function groupByChapter(notes: NoteWithId[]): { chapter: number | null; notes: NoteWithId[] }[] {
  const groups = new Map<number | null, NoteWithId[]>()
  for (const note of notes) {
    const existing = groups.get(note.chapter)
    if (existing) existing.push(note)
    else groups.set(note.chapter, [note])
  }
  return [...groups.entries()].map(([chapter, chapterNotes]) => ({ chapter, notes: chapterNotes }))
}

/**
 * `deleteBook` reads the server before it deletes anything, so a missing connection is
 * the one failure worth naming: nothing changed, and trying again on a signal will work.
 * `navigator.onLine` is deliberately not consulted — it reports link state rather than
 * whether Firestore is actually reachable.
 */
function deleteMessage(err: unknown): string {
  if ((err as { code?: unknown } | null)?.code === 'unavailable') {
    return 'No connection. A book can only be deleted online, so nothing was changed.'
  }
  return 'Could not delete this book.'
}

export function Book() {
  const { bookId = null } = useParams()
  const uid = useAuth((s) => s.user?.uid ?? null)
  const books = useBooks(uid)
  const book = useBook(books, bookId)
  const notes = useBookNotes(uid, bookId)
  const select = useLibrary((s) => s.select)
  const selectedBookId = useLibrary((s) => s.selectedBookId)
  const navigate = useNavigate()

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleted, setDeleted] = useState(false)

  const [filter, setFilter] = useState('')
  const deferredFilter = useDeferredValue(filter)
  const filterId = useId()

  /**
   * Filtering in place rather than sending you to the Search screen scoped to this book.
   * You are already looking at the book, and the chapter structure is the thing worth
   * keeping: chapters with no match drop out of the index *and* the column together,
   * because both are derived from the same array.
   *
   * The same matcher the Search screen uses, so "two words means both" holds in both
   * places and a query with regex metacharacters is escaped here too.
   */
  const terms = useMemo(() => queryTerms(deferredFilter), [deferredFilter])
  const visible = useMemo(
    () =>
      terms.length === 0 ? notes : searchNotes(notes, deferredFilter).map((hit) => hit.note),
    [notes, deferredFilter, terms],
  )

  const groups = useMemo(() => groupByChapter(visible), [visible])

  if (!uid) return <Navigate to="/" replace />

  // Above the `!book` guard, and the ordering is the whole point. Deleting your only book
  // leaves `books.length === 0`, which the guard below reads as "still loading" and
  // answers with `null` — a blank screen that never resolves, because no book is ever
  // coming.
  if (deleted) return <Navigate to="/books" replace />

  // The books subscription has to deliver before we can tell "still loading" from
  // "no such book", so an empty shelf is treated as the former.
  if (!book) {
    return books.length === 0 ? null : <Navigate to="/books" replace />
  }

  /**
   * The count is the only safety net here — there is no undo — so the confirmation spends
   * its words on it. `> 0` rather than `!== 0` because `forgetNoteOnBook` decrements
   * without a floor, and a drifted counter must not offer to delete "-1 notes".
   */
  const cost =
    book.noteCount > 0
      ? `“${book.title}” and its ${book.noteCount} note${book.noteCount === 1 ? '' : 's'} will be permanently deleted.`
      : `“${book.title}” will be permanently deleted.`

  const canExport = hasExportableNotes(notes)

  /**
   * Generated and handed over synchronously — no await anywhere. Everything it needs is
   * already in memory, which is the whole point of `SPEC §11`'s "runs entirely in the
   * browser": no function, no cost, and no reason for it to fail offline.
   */
  const exportMarkdown = () => {
    const { markdown, filename, written, skipped } = bookExport(book, notes)
    downloadBlob(new Blob([markdown], { type: MARKDOWN_MIME }), filename)

    const count = `${written} note${written === 1 ? '' : 's'}`
    toast.success(
      skipped === 0
        ? `Exported ${count}.`
        // Named rather than dropped silently: a note still transcribing will be there
        // next time, and one that failed never will.
        : `Exported ${count}. ${skipped} without a transcript left out.`,
    )
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await deleteBook(uid, book.id, () => {
        // Fired after the server read and before the first batch lands, so we leave the
        // screen ahead of the book disappearing out from under it — which is also what
        // keeps the dialog from being unmounted mid-write.
        if (selectedBookId === book.id) select(null)
        setDeleted(true)
      })
      toast.success('Book deleted.')
    } catch (err) {
      // Still on this screen with the dialog open: everything that can throw happens
      // before the callback, so nothing has been deleted and trying again is safe.
      console.error('[marginalia] delete book failed', err)
      toast.error(deleteMessage(err))
      setDeleting(false)
    }
  }

  return (
    <ReadingScreen width="wide">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link to="/books">
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <h1 className="line-clamp-1 flex-1 font-semibold">{book.title}</h1>
      </header>

      <div className="flex gap-4">
        <BookCover title={book.title} coverUrl={book.coverUrl} className="w-20 shrink-0" />

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* Metadata is frequently wrong (SPEC §9), so it stays editable forever —
              uncontrolled, so a keystroke never races the Firestore snapshot. */}
          <Input
            key={`${book.id}-title`}
            defaultValue={book.title}
            onBlur={(event) => {
              const value = event.target.value.trim()
              if (value && value !== book.title) void updateBook(uid, book.id, { title: value })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            aria-label="Book title"
            className="h-9 font-medium"
          />
          <Input
            key={`${book.id}-authors`}
            defaultValue={book.authors.join(', ')}
            onBlur={(event) => {
              const authors = event.target.value
                .split(',')
                .map((name) => name.trim())
                .filter((name) => name.length > 0)
              if (authors.join(', ') !== book.authors.join(', ')) {
                void updateBook(uid, book.id, { authors })
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            placeholder="Author"
            aria-label="Author"
            className="h-9 text-sm"
          />
          <p className="text-muted-foreground text-xs">
            {book.noteCount} note{book.noteCount === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      <Tabs
        value={book.status}
        onValueChange={(value) =>
          void updateBook(uid, book.id, { status: value as BookDoc['status'] })
        }
      >
        <TabsList className="w-full">
          {STATUSES.map(({ status, label }) => (
            <TabsTrigger key={status} value={status} className="flex-1">
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex gap-2">
        <Button
          className="flex-1"
          onClick={() => {
            select(book.id)
            void navigate('/')
          }}
        >
          <Mic className="h-4 w-4" />
          Record against this book
        </Button>

        {/* Reads the notes already on screen — the export is a pure transform of this
            subscription, so it costs no read and works offline (`SPEC §11`).

            "yet" is doing real work in that label. `useBookNotes` has no `loading` flag,
            so a book that *does* have notes sits here for the moment before its
            subscription delivers, and a message asserting the book is empty would be
            wrong exactly then. */}
        <Button
          variant="outline"
          disabled={!canExport}
          title={canExport ? undefined : 'No notes to export yet.'}
          onClick={exportMarkdown}
        >
          <Download className="h-4 w-4" />
          Export
        </Button>
      </div>

      {/* Only once there is something to search. On a book with three notes a filter box
          is furniture; on one with two hundred it is the only way back to a thought. */}
      {notes.length > 0 ? (
        <div className="relative">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            id={filterId}
            name="book-search"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={`Search this book’s ${notes.length} note${notes.length === 1 ? '' : 's'}`}
            aria-label="Search this book’s notes"
            className="h-9 pl-9"
          />
        </div>
      ) : null}

      {groups.length === 0 ? (
        <p className="text-muted-foreground py-10 text-center text-sm">
          {terms.length > 0
            ? 'No notes in this book match that.'
            : 'No notes on this book yet.'}
        </p>
      ) : (
        // Two panes on a desktop, one on a phone. Everything above this stays full
        // width — the cover, the editable metadata, the shelf tabs and the two buttons
        // are a header band, not part of the reading column.
        <div className="lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10">
          <ChapterIndex groups={groups} chapterTitles={book.chapterTitles} />

          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <ChapterNotes
                key={group.chapter ?? 'unfiled'}
                uid={uid}
                book={book}
                chapter={group.chapter}
                notes={group.notes}
                terms={terms}
              />
            ))}
          </div>
        </div>
      )}

      {/* `Delete book` rather than `Delete`, because this sits directly below the book's
          notes and the bare word reads as acting on one of them. */}
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          // A delete in flight owns the dialog until it resolves. Cancel is already gone
          // by then, but Escape would otherwise pull the loading state out from under it.
          if (deleting) return
          setConfirmOpen(next)
        }}
      >
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" className="text-muted-foreground mt-auto self-start">
            <Trash2 className="h-3.5 w-3.5" />
            Delete book
          </Button>
        </AlertDialogTrigger>

        <AlertDialogContent onEscapeKeyDown={(event) => deleting && event.preventDefault()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this book?</AlertDialogTitle>
            <AlertDialogDescription>
              {cost} This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* Withdrawn once the write starts — there is nothing left to cancel, and a
                dead-but-visible button is worse than none. */}
            {deleting ? null : <AlertDialogCancel>Keep it</AlertDialogCancel>}
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              // Radix closes on Action by default. The dialog has to stay up and show the
              // work instead, because the server read it is waiting on can still fail.
              onClick={(event) => {
                event.preventDefault()
                void remove()
              }}
            >
              {deleting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ReadingScreen>
  )
}
