import { Plus } from 'lucide-react'
import { useState } from 'react'

import { NoteList } from '@/components/NoteList'
import { Input } from '@/components/ui/input'
import { chapterHeading, setChapterTitle } from '@/lib/books'
import { chapterAnchor } from '@/lib/format'
import type { BookWithId, NoteWithId } from '@/lib/types'

interface ChapterNotesProps {
  uid: string
  book: BookWithId
  chapter: number | null
  notes: NoteWithId[]
  /** Non-empty when the book's notes are filtered — marks the matches. */
  terms?: string[]
}

/**
 * One chapter's notes on the book screen, under a heading that doubles as the place to
 * name the chapter (SPEC §8). Titles are worth adding after the fact as well as during
 * reading, because the Whisper prompt picks them up for every later note.
 */
export function ChapterNotes({ uid, book, chapter, notes, terms = [] }: ChapterNotesProps) {
  const [editing, setEditing] = useState(false)
  const title = chapter === null ? null : (book.chapterTitles?.[String(chapter)] ?? null)
  /** Reader's title, else the printed contents — display only (ADR-026). */
  const heading = chapterHeading(book, chapter)

  const commit = (value: string) => {
    setEditing(false)
    if (chapter === null || value.trim() === (title ?? '')) return
    void setChapterTitle(uid, book.id, chapter, value)
  }

  return (
    // `scroll-mt-6` so a jump from the desktop chapter index leaves the heading clear of
    // the top edge rather than flush against it.
    <section id={chapterAnchor(chapter)} className="flex scroll-mt-6 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {chapter === null ? 'Unfiled' : `Chapter ${chapter}`}
        </h2>
        <span className="text-muted-foreground text-xs">
          {notes.length} note{notes.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Unfiled is not a chapter, so there is nothing to name. */}
      {chapter === null ? null : editing ? (
        <Input
          autoFocus
          /* Seeded from the printed contents when the reader has no title of their own,
             so adopting it is one tap and still their decision (ADR-026). */
          defaultValue={title ?? heading?.title ?? ''}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setEditing(false)
          }}
          placeholder={`Title for chapter ${chapter}`}
          aria-label={`Title for chapter ${chapter}`}
          className="h-8 text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 self-start rounded text-xs transition-colors"
        >
          {heading ? (
            <>
              <span className="italic">{heading.title}</span>
              {heading.source === 'printed' ? (
                <span className="opacity-70">· as printed</span>
              ) : null}
            </>
          ) : (
            <>
              <Plus className="h-3 w-3" />
              title
            </>
          )}
        </button>
      )}

      <NoteList notes={notes} showChapter={false} terms={terms} />
    </section>
  )
}
