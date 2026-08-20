import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { setChapterTitle, updateBook } from '@/lib/books'
import type { BookWithId } from '@/lib/types'

interface ChapterStepperProps {
  uid: string
  book: BookWithId
}

/**
 * A stepper, not a picker (SPEC §8). `›` advances, the number *is* the identity, so
 * nothing needs creating and nothing interrupts reading. A chapter title is an optional
 * aside — worth having, because the Whisper prompt uses it (SPEC §7) — and it opens
 * inline rather than in a dialog.
 */
export function ChapterStepper({ uid, book }: ChapterStepperProps) {
  const [editingTitle, setEditingTitle] = useState(false)

  const chapter = book.currentChapter
  const chapterTitle = chapter === null ? null : (book.chapterTitles?.[String(chapter)] ?? null)

  /** Stepping below chapter 1 lands on Unfiled, which is always available (SPEC §8). */
  const step = (delta: number) => {
    const next = chapter === null ? (delta > 0 ? 1 : null) : chapter + delta
    void updateBook(uid, book.id, { currentChapter: next !== null && next < 1 ? null : next })
  }

  const commitTitle = (value: string) => {
    setEditingTitle(false)
    if (chapter === null) return
    if (value.trim() === (chapterTitle ?? '')) return
    void setChapterTitle(uid, book.id, chapter, value)
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-center text-base leading-tight font-medium text-balance">
        {book.title}
      </p>

      <div className="flex items-center justify-center gap-1">
        <Button variant="ghost" size="icon" onClick={() => step(-1)} aria-label="Previous chapter">
          <ChevronLeft className="h-5 w-5" />
        </Button>

        <span className="min-w-28 text-center text-sm font-medium tabular-nums">
          {chapter === null ? 'Unfiled' : `Chapter ${chapter}`}
        </span>

        <Button variant="ghost" size="icon" onClick={() => step(1)} aria-label="Next chapter">
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>

      {/* Unfiled is not a chapter, so it has no title to give. */}
      {chapter === null ? null : editingTitle ? (
        <Input
          autoFocus
          defaultValue={chapterTitle ?? ''}
          onBlur={(event) => commitTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setEditingTitle(false)
          }}
          placeholder={`Title for chapter ${chapter}`}
          aria-label={`Title for chapter ${chapter}`}
          className="h-9 text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditingTitle(true)}
          className="text-muted-foreground hover:text-foreground mx-auto flex items-center gap-1 rounded text-xs transition-colors"
        >
          {chapterTitle ? (
            <span className="line-clamp-1 italic">{chapterTitle}</span>
          ) : (
            <>
              <Plus className="h-3 w-3" />
              title
            </>
          )}
        </button>
      )}
    </div>
  )
}
