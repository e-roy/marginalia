import { Plus } from 'lucide-react'

import { BookCover } from '@/components/BookCover'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { BookWithId } from '@/lib/types'
import { cn } from '@/lib/utils'

interface BookSwitcherProps {
  books: BookWithId[]
  selectedId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (bookId: string) => void
  onAdd: () => void
  /**
   * Fired once the sheet has finished closing and unmounted — Radix's
   * `onCloseAutoFocus`, which runs from the focus scope's unmount, so it lands *after*
   * the exit animation rather than at the moment the state flips.
   *
   * `Now` uses it to open the add-book sheet only once this one is gone. Two Radix
   * overlays mounted together share `react-remove-scroll-bar`'s refcount and can leave
   * `pointer-events: none` behind on the body — and this app's overlays have already
   * produced two device-only layout bugs, so the sequencing is explicit rather than
   * left to whichever effect happens to run first.
   */
  onClosed: () => void
}

/**
 * Which book the next note gets filed under (`SPEC §8`).
 *
 * Until 2026-08-25 this was a permanent strip of four covers across the top of the Now
 * screen. It made switching free, and in doing so made the capture screen about the
 * shelf — four books visible on the one screen whose whole job is a single thought about
 * a single book. Switching is now a deliberate two taps and the screen names one book.
 *
 * **Every** book, not a recent few. The old strip had to choose, because it spent screen
 * space permanently; a sheet you opened on purpose does not, and "the book I want is not
 * in these four" was the strip's one real failure mode. Order is `useBooks`' own
 * most-recently-touched sort, so what you are actually reading is at the top and the
 * ordering matches everywhere else it is shown.
 *
 * The selection itself is untouched by all of this: device-local in `localStorage`,
 * falling back to the most recently touched book (ADR-010).
 */
export function BookSwitcher({
  books,
  selectedId,
  open,
  onOpenChange,
  onSelect,
  onAdd,
  onClosed,
}: BookSwitcherProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* `side="bottom"` is load-bearing, not styling: the keyboard-inset and
          `max-height` rule in `index.css` is keyed to
          `[data-slot="sheet-content"][data-side="bottom"]` and applies to nothing else.
          `overflow-y-auto` because this list is as long as the shelf. */}
      <SheetContent
        side="bottom"
        className="overflow-y-auto"
        onCloseAutoFocus={onClosed}
      >
        <SheetHeader>
          {/* Radix warns to the console without a title, and a sheet with no heading is
              worse for a screen reader than one with a redundant heading. */}
          <SheetTitle>Switch book</SheetTitle>
          <SheetDescription>The next note is filed under the book you pick.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-2 px-4 pb-4">
          <ul className="flex flex-col">
            {books.map((book) => {
              const isSelected = book.id === selectedId
              return (
                <li key={book.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(book.id)}
                    aria-current={isSelected ? 'true' : undefined}
                    className={cn(
                      'focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
                      isSelected ? 'bg-accent' : 'hover:bg-accent/40',
                    )}
                  >
                    <BookCover
                      title={book.title}
                      coverUrl={book.coverUrl}
                      className="w-10 shrink-0"
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className={cn(
                          'line-clamp-2 text-sm leading-tight',
                          isSelected ? 'font-medium' : '',
                        )}
                      >
                        {book.title}
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        {book.authors.join(', ') || 'Unknown author'}
                        {' · '}
                        {book.noteCount} note{book.noteCount === 1 ? '' : 's'}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>

          {/* The strip's dashed tile was the only way to add a book from this screen, so
              it comes along rather than being dropped. At the end, because adding is the
              rarer of the two things this sheet does. */}
          <Button variant="outline" onClick={onAdd} className="w-full">
            <Plus className="h-4 w-4" />
            Add a book
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
