import { Plus } from 'lucide-react'

import { BookCover } from '@/components/BookCover'
import type { BookWithId } from '@/lib/types'
import { cn } from '@/lib/utils'

interface BookStripProps {
  books: BookWithId[]
  selectedId: string | null
  onSelect: (bookId: string) => void
  onAdd: () => void
}

/** Four fits across a phone alongside the add tile without the covers going tiny. */
const VISIBLE = 4

/**
 * The last few books touched, most recent first (SPEC §8). Switching is one tap, and
 * each book brings its own `currentChapter` with it.
 */
export function BookStrip({ books, selectedId, onSelect, onAdd }: BookStripProps) {
  // `books` arrives most-recently-touched first. If the selection is an older book —
  // picked from the shelf rather than the strip — it takes the last visible slot, so
  // the strip always shows what you are actually recording against.
  let shown = books.slice(0, VISIBLE)
  if (selectedId !== null && !shown.some((book) => book.id === selectedId)) {
    const selected = books.find((book) => book.id === selectedId)
    if (selected) shown = [...shown.slice(0, VISIBLE - 1), selected]
  }

  return (
    // A fixed grid rather than a flex row: the tiles must keep their size whatever the
    // shelf holds. Flexed, a lone add tile stretches to the full width of the card.
    <ul className="grid grid-cols-5 items-start gap-2">
      {shown.map((book) => {
        const isSelected = book.id === selectedId
        return (
          <li key={book.id} className="min-w-0">
            <button
              type="button"
              onClick={() => onSelect(book.id)}
              aria-current={isSelected ? 'true' : undefined}
              className="focus-visible:ring-ring/50 group flex w-full flex-col gap-1.5 rounded-md text-left focus-visible:ring-2 focus-visible:outline-none"
            >
              <BookCover
                title={book.title}
                coverUrl={book.coverUrl}
                className={cn(
                  'transition-opacity',
                  isSelected ? 'ring-primary ring-2' : 'opacity-60 group-hover:opacity-100',
                )}
              />
              <span
                className={cn(
                  'line-clamp-2 text-[0.6875rem] leading-tight',
                  isSelected ? 'font-medium' : 'text-muted-foreground',
                )}
              >
                {book.title}
              </span>
            </button>
          </li>
        )
      })}

      <li className="min-w-0">
        <button
          type="button"
          onClick={onAdd}
          className="focus-visible:ring-ring/50 border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 flex aspect-[2/3] w-full items-center justify-center rounded-md border border-dashed transition-colors focus-visible:ring-2 focus-visible:outline-none"
          aria-label="Add a book"
        >
          <Plus className="h-5 w-5" />
        </button>
      </li>
    </ul>
  )
}
