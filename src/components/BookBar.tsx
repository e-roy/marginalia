import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { updateBook } from '@/lib/notes'
import type { Book } from '@/lib/types'

interface BookBarProps {
  uid: string
  book: Book | null
}

/**
 * The book and chapter a recording gets filed under, and the only source of the Whisper
 * prompt — which SPEC §7 calls the highest-leverage detail in the whole design, so M2
 * needs it real rather than stubbed.
 *
 * This is a placeholder for the Milestone 3 shelf: one book, typed in by hand. The
 * chapter stepper, though, is the real design — `›` advances, the number *is* the
 * identity, and nothing needs creating (SPEC §8).
 */
export function BookBar({ uid, book }: BookBarProps) {
  /**
   * `null` means "not editing", so the field just shows whatever is stored — including
   * a title that arrives late, or one changed from another device. While someone is
   * typing, the draft wins and nothing yanks the field out from under them.
   *
   * This was an effect that copied the stored title into state. Besides forcing a
   * second render, it only adopted the stored value while the field was empty, so a
   * title changed elsewhere never appeared.
   */
  const [draft, setDraft] = useState<string | null>(null)
  const title = draft ?? book?.title ?? ''

  const chapter = book?.currentChapter ?? null

  const commitTitle = () => {
    if (draft === null) return // nothing was typed
    const trimmed = draft.trim()
    setDraft(null) // back to showing the stored value
    if (!book || trimmed === book.title) return
    void updateBook(uid, { title: trimmed || 'Untitled book' })
  }

  /** Stepping below chapter 1 lands on Unfiled, which is always available (SPEC §8). */
  const step = (delta: number) => {
    const next = chapter === null ? (delta > 0 ? 1 : null) : chapter + delta
    void updateBook(uid, { currentChapter: next !== null && next < 1 ? null : next })
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        value={title}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitTitle}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        placeholder="What are you reading?"
        aria-label="Book title"
        className="h-11 text-base font-medium"
      />

      <div className="flex items-center justify-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => step(-1)}
          disabled={!book || chapter === null}
          aria-label="Previous chapter"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>

        <span className="min-w-32 text-center text-sm font-medium tabular-nums">
          {chapter === null ? 'Unfiled' : `Chapter ${chapter}`}
        </span>

        <Button
          variant="ghost"
          size="icon"
          onClick={() => step(1)}
          disabled={!book}
          aria-label="Next chapter"
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>
    </div>
  )
}
