import { ChevronLeft, Download, Mic, Search as SearchIcon } from 'lucide-react'
import { useDeferredValue, useId, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { BookCover } from '@/components/BookCover'
import { ChapterIndex } from '@/components/ChapterIndex'
import { ChapterNotes } from '@/components/ChapterNotes'
import { ReadingScreen } from '@/components/ReadingScreen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBook, useBookNotes, useBooks } from '@/hooks/useLibrary'
import { updateBook } from '@/lib/books'
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

export function Book() {
  const { bookId = null } = useParams()
  const uid = useAuth((s) => s.user?.uid ?? null)
  const books = useBooks(uid)
  const book = useBook(books, bookId)
  const notes = useBookNotes(uid, bookId)
  const select = useLibrary((s) => s.select)
  const navigate = useNavigate()


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

  // The books subscription has to deliver before we can tell "still loading" from
  // "no such book", so an empty shelf is treated as the former.
  if (!book) {
    return books.length === 0 ? null : <Navigate to="/books" replace />
  }

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

      {/*
        Identity as plain text, not as inputs.

        Until 2026-08-25 the title and author were live text fields here, and the metadata
        the scanner brings back joined them. Eric's objection on the day that shipped is the
        right one: a live field above the notes you came to read is a mis-tap away from
        rewriting a title the scanner got right. `SPEC §9` wants a correction to be
        *reachable* — it does not want every field *armed*. Corrections moved to
        `/books/:id/details`, behind an explicit Edit.
      */}
      <div className="flex gap-4">
        <BookCover title={book.title} coverUrl={book.coverUrl} className="w-20 shrink-0" />

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <p className="font-medium">{book.title}</p>
          {book.subtitle ? (
            <p className="text-muted-foreground text-sm">{book.subtitle}</p>
          ) : null}
          <p className="text-muted-foreground text-sm">{book.authors.join(', ') || 'Unknown author'}</p>
          <p className="text-muted-foreground text-xs">
            {book.noteCount} note{book.noteCount === 1 ? '' : 's'}
          </p>
          <Button variant="link" asChild className="h-auto justify-start p-0 text-xs">
            <Link to={`/books/${book.id}/details`}>Details and editing</Link>
          </Button>
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
          <ChapterIndex groups={groups} book={book} />

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
    </ReadingScreen>
  )
}
