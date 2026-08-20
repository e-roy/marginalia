import { ChevronLeft, Mic } from 'lucide-react'
import { useMemo } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'

import { BookCover } from '@/components/BookCover'
import { ChapterNotes } from '@/components/ChapterNotes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBook, useBookNotes, useBooks } from '@/hooks/useLibrary'
import { updateBook } from '@/lib/books'
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

  const groups = useMemo(() => groupByChapter(notes), [notes])

  if (!uid) return <Navigate to="/" replace />

  // The books subscription has to deliver before we can tell "still loading" from
  // "no such book", so an empty shelf is treated as the former.
  if (!book) {
    return books.length === 0 ? null : <Navigate to="/books" replace />
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-5 py-6">
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

      <Button
        onClick={() => {
          select(book.id)
          void navigate('/')
        }}
      >
        <Mic className="h-4 w-4" />
        Record against this book
      </Button>

      {groups.length === 0 ? (
        <p className="text-muted-foreground py-10 text-center text-sm">
          No notes on this book yet.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <ChapterNotes
              key={group.chapter ?? 'unfiled'}
              uid={uid}
              book={book}
              chapter={group.chapter}
              notes={group.notes}
            />
          ))}
        </div>
      )}
    </div>
  )
}
