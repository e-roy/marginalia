import { Loader2, Search } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import { BookCover } from '@/components/BookCover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { createBook, type NewBook } from '@/lib/books'
import { searchBooks, type BookCandidate } from '@/lib/openLibrary'

interface AddBookSheetProps {
  uid: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The new book is always selected straight away — you add one in order to use it. */
  onAdded: (bookId: string) => void
}

/** Long enough that typing a title doesn't fire a request per keystroke (SPEC §9). */
const DEBOUNCE_MS = 300

/**
 * The form's own shape. Authors stay a raw string while being typed and are only split
 * on submit — parsing them into an array on every keystroke and joining them back for
 * display eats the space the moment you type it, so "Daniel Kahneman" becomes
 * "DanielKahneman".
 */
interface Draft {
  title: string
  authorsText: string
  coverUrl: string | null
  openLibraryKey: string | null
}

function draftFrom(candidate: BookCandidate): Draft {
  return {
    title: candidate.title,
    authorsText: candidate.authors.join(', '),
    coverUrl: candidate.coverUrl,
    openLibraryKey: candidate.openLibraryKey,
  }
}

function toNewBook(draft: Draft): NewBook {
  return {
    title: draft.title,
    authors: draft.authorsText
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    coverUrl: draft.coverUrl,
    openLibraryKey: draft.openLibraryKey,
  }
}

/**
 * Two of the three paths from SPEC §9 — Open Library search and manual entry. The third,
 * the barcode scanner, is M5 and joins the same form.
 *
 * Both paths end in the *same editable form* rather than creating a book outright.
 * Open Library metadata is frequently wrong, and the moment to fix it is before the
 * book exists, not after.
 */
export function AddBookSheet({ uid, open, onOpenChange, onAdded }: AddBookSheetProps) {
  const [query, setQuery] = useState('')
  /**
   * Results and failures are stored with the query they belong to, and the "searching"
   * state is derived from the two. Keying them this way means a stale response can
   * never overwrite a newer one, and nothing has to be synchronously cleared as the
   * query changes.
   */
  const [found, setFound] = useState<{ query: string; hits: BookCandidate[] } | null>(null)
  const [failed, setFailed] = useState<{ query: string; message: string } | null>(null)
  /** Non-null puts the sheet in form mode: null is the search list. */
  const [draft, setDraft] = useState<Draft | null>(null)

  const trimmed = query.trim()
  const hits = found?.query === trimmed ? found.hits : null
  const error = failed?.query === trimmed ? failed.message : null
  const searching = trimmed.length > 0 && hits === null && error === null

  useEffect(() => {
    if (trimmed.length === 0) return

    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchBooks(trimmed, controller.signal)
        .then((results) => setFound({ query: trimmed, hits: results }))
        .catch((err) => {
          if (controller.signal.aborted) return
          console.warn('[marginalia] Open Library search failed', err)
          setFailed({
            query: trimmed,
            message: "Couldn't reach Open Library. You can still add the book by hand.",
          })
        })
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [trimmed])

  /** A fresh sheet every time — a half-typed search from last time is never useful. */
  const reset = () => {
    setQuery('')
    setFound(null)
    setFailed(null)
    setDraft(null)
  }

  const close = () => {
    onOpenChange(false)
    reset()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft || draft.title.trim().length === 0) return
    const bookId = await createBook(uid, toNewBook(draft))
    onAdded(bookId)
    close()
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{draft ? 'Add this book' : 'Add a book'}</SheetTitle>
          <SheetDescription>
            {draft
              ? 'Check the details — you can change them now or later.'
              : 'Search Open Library, or add it by hand.'}
          </SheetDescription>
        </SheetHeader>

        {draft ? (
          <form onSubmit={submit} className="flex flex-col gap-4 px-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="book-title" className="text-sm font-medium">
                Title
              </label>
              <Input
                id="book-title"
                autoFocus={draft.title.length === 0}
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                placeholder="What are you reading?"
                className="h-11 text-base"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="book-authors" className="text-sm font-medium">
                Author
              </label>
              <Input
                id="book-authors"
                value={draft.authorsText}
                onChange={(event) => setDraft({ ...draft, authorsText: event.target.value })}
                placeholder="Optional"
                className="h-11 text-base"
              />
              {/* The author reaches the Whisper prompt, which is why it is worth a
                  field of its own rather than being folded into the title. */}
              <p className="text-muted-foreground text-xs">
                Separate multiple authors with commas.
              </p>
            </div>

            <SheetFooter className="flex-row gap-2 px-0">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDraft(null)}
                className="flex-1"
              >
                Back
              </Button>
              <Button type="submit" disabled={draft.title.trim().length === 0} className="flex-1">
                Add book
              </Button>
            </SheetFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-3 px-4 pb-4">
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Title or author"
                aria-label="Search Open Library"
                className="h-11 pl-9 text-base"
              />
              {searching ? (
                <Loader2 className="text-muted-foreground absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin" />
              ) : null}
            </div>

            {error ? <p className="text-muted-foreground text-sm">{error}</p> : null}

            {hits && hits.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Nothing found. Add it by hand instead.
              </p>
            ) : null}

            {hits && hits.length > 0 ? (
              <ul className="flex flex-col">
                {hits.map((hit, index) => (
                  <li key={hit.openLibraryKey ?? `${hit.title}-${index}`}>
                    <button
                      type="button"
                      onClick={() => setDraft(draftFrom(hit))}
                      className="hover:bg-muted flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors"
                    >
                      <BookCover
                        title={hit.title}
                        coverUrl={hit.coverUrl}
                        className="w-10 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 block text-sm font-medium">{hit.title}</span>
                        <span className="text-muted-foreground line-clamp-1 block text-xs">
                          {hit.authors.join(', ') || 'Unknown author'}
                          {hit.firstPublishYear ? ` · ${hit.firstPublishYear}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* Always available, always the fallback — including when the search is
                unreachable, which on a phone is a normal Tuesday. */}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDraft({ title: trimmed, authorsText: '', coverUrl: null, openLibraryKey: null })
              }
              className="mt-1"
            >
              Add by hand
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
