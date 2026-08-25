import { ChevronLeft, Search as SearchIcon } from 'lucide-react'
import { useDeferredValue, useId, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'

import { Highlighted } from '@/components/Highlighted'
import { ReadingScreen } from '@/components/ReadingScreen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAllNotes } from '@/hooks/useLibrary'
import { formatClockTime, formatNoteDate } from '@/lib/format'
import { queryTerms, searchNotes } from '@/lib/search'
import { useAuth } from '@/stores/auth'

/**
 * Search across every note (`SPEC §8`).
 *
 * Its own screen rather than a `⌘K` palette: `SPEC §8` puts it in the screens table, and a
 * palette is a desktop idiom in an app whose primary target is a phone. shadcn's `command`
 * was checked and deliberately not used — it would add `cmdk` for that idiom.
 */

export function Search() {
  const uid = useAuth((s) => s.user?.uid ?? null)
  const notes = useAllNotes(uid)
  const [query, setQuery] = useState('')
  const fieldId = useId()

  // React 19's own answer to a debounce: typing stays responsive and the (cheap) filter
  // runs at a lower priority. No timer to tune, and no stale-result window.
  const deferred = useDeferredValue(query)

  const terms = useMemo(() => queryTerms(deferred), [deferred])
  const hits = useMemo(() => searchNotes(notes, deferred), [notes, deferred])

  if (!uid) return <Navigate to="/" replace />

  return (
    <ReadingScreen>
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link to="/">
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <h1 className="flex-1 font-semibold">Search</h1>
      </header>

      <div className="relative">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
        {/* `id` and `name` are not decoration — DevTools flags a form field without
            either, and the app already carries two such advisories on the Book screen.
            Not adding a third. */}
        <Input
          autoFocus
          id={fieldId}
          name="search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search your notes"
          aria-label="Search your notes"
          className="pl-9"
        />
      </div>

      {terms.length === 0 ? (
        <p className="text-muted-foreground py-10 text-center text-sm">
          Type to search across every note.
        </p>
      ) : hits.length === 0 ? (
        <p className="text-muted-foreground py-10 text-center text-sm">
          Nothing matches {terms.length === 1 ? 'that' : 'all of those words'}.
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            {hits.length} note{hits.length === 1 ? '' : 's'}
          </p>

          <ul className="flex flex-col gap-4">
            {hits.map(({ note, snippet }) => (
              <li key={note.id} className="border-border/60 border-b last:border-0">
                <Link
                  to={`/notes/${note.id}`}
                  className="hover:bg-accent/40 -mx-2 flex flex-col gap-1 rounded-md px-2 py-1 pb-4 transition-colors"
                >
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                    <span className="font-medium">
                      <Highlighted text={note.bookTitle} terms={terms} />
                    </span>
                    <span aria-hidden>·</span>
                    <span>{note.chapter === null ? 'Unfiled' : `Chapter ${note.chapter}`}</span>
                    <span aria-hidden>·</span>
                    {/* A search result is the case furthest from "today" by definition —
                        you are looking for something you wrote a while ago. */}
                    {formatNoteDate(note.recordedAt) ? (
                      <span>{formatNoteDate(note.recordedAt)}</span>
                    ) : null}
                    <span className="tabular-nums">{formatClockTime(note.recordedAt)}</span>
                  </div>

                  {note.title ? (
                    <p className="text-sm font-medium">
                      <Highlighted text={note.title} terms={terms} />
                    </p>
                  ) : null}

                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    <Highlighted text={snippet} terms={terms} />
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </ReadingScreen>
  )
}
