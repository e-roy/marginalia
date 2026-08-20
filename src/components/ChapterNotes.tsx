import { Plus } from 'lucide-react'
import { useState } from 'react'

import { NoteList } from '@/components/NoteList'
import { Input } from '@/components/ui/input'
import { setChapterTitle } from '@/lib/books'
import type { BookWithId, NoteWithId } from '@/lib/types'

interface ChapterNotesProps {
  uid: string
  book: BookWithId
  chapter: number | null
  notes: NoteWithId[]
}

/**
 * One chapter's notes on the book screen, under a heading that doubles as the place to
 * name the chapter (SPEC §8). Titles are worth adding after the fact as well as during
 * reading, because the Whisper prompt picks them up for every later note.
 */
export function ChapterNotes({ uid, book, chapter, notes }: ChapterNotesProps) {
  const [editing, setEditing] = useState(false)
  const title = chapter === null ? null : (book.chapterTitles?.[String(chapter)] ?? null)

  const commit = (value: string) => {
    setEditing(false)
    if (chapter === null || value.trim() === (title ?? '')) return
    void setChapterTitle(uid, book.id, chapter, value)
  }

  return (
    <section className="flex flex-col gap-2">
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
          defaultValue={title ?? ''}
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
          {title ? (
            <span className="italic">{title}</span>
          ) : (
            <>
              <Plus className="h-3 w-3" />
              title
            </>
          )}
        </button>
      )}

      <NoteList notes={notes} showChapter={false} />
    </section>
  )
}
