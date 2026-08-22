import { ChevronLeft, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { AddBookSheet } from '@/components/AddBookSheet'
import { BookCover } from '@/components/BookCover'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useBooks } from '@/hooks/useLibrary'
import { useScannedDraft } from '@/hooks/useScannedDraft'
import type { Book, BookWithId } from '@/lib/types'
import { useAuth } from '@/stores/auth'
import { useLibrary } from '@/stores/library'

/** Reading first, because that is the shelf you actually visit (SPEC §8). */
const SHELVES: { status: Book['status']; label: string }[] = [
  { status: 'reading', label: 'Reading' },
  { status: 'finished', label: 'Finished' },
  { status: 'shelved', label: 'Shelved' },
]

function Shelf({ books }: { books: BookWithId[] }) {
  if (books.length === 0) {
    return <p className="text-muted-foreground py-10 text-center text-sm">Nothing here yet.</p>
  }

  return (
    <ul className="grid grid-cols-3 gap-x-3 gap-y-4">
      {books.map((book) => (
        <li key={book.id}>
          <Link
            to={`/books/${book.id}`}
            className="focus-visible:ring-ring/50 flex flex-col gap-1.5 rounded-md focus-visible:ring-2 focus-visible:outline-none"
          >
            <BookCover title={book.title} coverUrl={book.coverUrl} />
            <span className="line-clamp-2 text-xs leading-tight font-medium">{book.title}</span>
            <span className="text-muted-foreground text-[0.6875rem]">
              {book.noteCount} note{book.noteCount === 1 ? '' : 's'}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** The whole shelf, grouped by status. */
export function Books() {
  const uid = useAuth((s) => s.user?.uid ?? null)
  const books = useBooks(uid)
  const select = useLibrary((s) => s.select)
  const navigate = useNavigate()

  const [addingBook, setAddingBook] = useState(false)
  const scanned = useScannedDraft()

  return (
    <div className="mx-auto flex min-h-[var(--app-height)] w-full max-w-md flex-col gap-4 px-5 py-6">
      <header className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link to="/">
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <h1 className="flex-1 text-lg font-semibold">Books</h1>
        <Button variant="ghost" size="icon" onClick={() => setAddingBook(true)} aria-label="Add a book">
          <Plus className="h-5 w-5" />
        </Button>
      </header>

      <Tabs defaultValue="reading">
        <TabsList className="w-full">
          {SHELVES.map(({ status, label }) => (
            <TabsTrigger key={status} value={status} className="flex-1">
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {SHELVES.map(({ status }) => (
          <TabsContent key={status} value={status} className="mt-4">
            <Shelf books={books.filter((book) => book.status === status)} />
          </TabsContent>
        ))}
      </Tabs>

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
          // Adding from the shelf means you intend to read it: select it and go
          // straight to its page, rather than leaving the user to find it.
          onAdded={(bookId) => {
            select(bookId)
            void navigate(`/books/${bookId}`)
          }}
        />
      ) : null}
    </div>
  )
}
