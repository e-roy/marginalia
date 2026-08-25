import { Loader2, ScanBarcode, Search } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

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
import { isCameraSupported } from '@/lib/camera'
import { searchBooks, type BookCandidate, type TocEntry } from '@/lib/openLibrary'

interface AddBookSheetProps {
  uid: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The new book is always selected straight away — you add one in order to use it. */
  onAdded: (bookId: string) => void
  /**
   * A draft to open straight into form mode with — how the scanner hands its result
   * back. Read once, as the initial value of `draft`, so the parent must **remount**
   * this component (via `key`) to deliver a new one. That is deliberate: the sheet
   * clears `draft` on every close, so a prop alone could never seed a later open, and
   * seeding through an effect would race the parent clearing its router state.
   */
  initialDraft?: Draft | null
}

/** Long enough that typing a title doesn't fire a request per keystroke (SPEC §9). */
const DEBOUNCE_MS = 300

/**
 * The form's own shape. Authors stay a raw string while being typed and are only split
 * on submit — parsing them into an array on every keystroke and joining them back for
 * display eats the space the moment you type it, so "Daniel Kahneman" becomes
 * "DanielKahneman".
 */
export interface Draft {
  title: string
  authorsText: string
  coverUrl: string | null
  openLibraryKey: string | null
  /** Set only by the scanner; the other two paths have no ISBN to offer. */
  isbn13: string | null
  /**
   * Carried through the form but not edited in it. The form asks for the two things a
   * reader can correct from the book in their hand; the rest is Open Library's, shown
   * below as a summary and editable later on the Book screen where there is room for it.
   */
  subtitle: string | null
  publishYear: number | null
  pageCount: number | null
  publisher: string | null
  subjects: string[]
  subjectPeople: string[]
  description: string | null
  tableOfContents: TocEntry[]
}

function draftFrom(candidate: BookCandidate): Draft {
  return {
    title: candidate.title,
    authorsText: candidate.authors.join(', '),
    coverUrl: candidate.coverUrl,
    openLibraryKey: candidate.openLibraryKey,
    isbn13: candidate.isbn13,
    subtitle: candidate.subtitle,
    publishYear: candidate.firstPublishYear,
    pageCount: candidate.pageCount,
    publisher: candidate.publisher,
    subjects: candidate.subjects,
    subjectPeople: candidate.subjectPeople,
    description: candidate.description,
    tableOfContents: candidate.tableOfContents,
  }
}

/** A blank form, which is what "add it by hand" and a book Open Library doesn't know both start from. */
function emptyDraft(title: string, isbn13: string | null = null): Draft {
  return {
    title,
    authorsText: '',
    coverUrl: null,
    openLibraryKey: null,
    isbn13,
    subtitle: null,
    publishYear: null,
    pageCount: null,
    publisher: null,
    subjects: [],
    subjectPeople: [],
    description: null,
    tableOfContents: [],
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
    // `Book.isbn13` has existed since M3 and nothing ever wrote a non-null value into
    // it. The scanner is what finally does.
    isbn13: draft.isbn13,
    subtitle: draft.subtitle,
    publishYear: draft.publishYear,
    pageCount: draft.pageCount,
    publisher: draft.publisher,
    subjects: draft.subjects,
    subjectPeople: draft.subjectPeople,
    description: draft.description,
    tableOfContents: draft.tableOfContents,
  }
}

/**
 * A barcode that read cleanly and a book Open Library has never heard of.
 *
 * The two are indistinguishable on screen otherwise — both land on this form — and the
 * blank one reads as "the scan failed". It usually has not: `979-8` is the Amazon KDP and
 * independent-publishing range, where Open Library's coverage is thin, and
 * `9798250875660` was reported as a book that "didn't scan" when in fact it decoded
 * perfectly and simply is not in the catalogue.
 *
 * An ISBN with no title is the discriminator: manual entry never carries one, and a
 * successful lookup always brings a title back (`lookupIsbn` returns null without one).
 */
function isScannedButUnknown(draft: Draft): boolean {
  return draft.isbn13 !== null && draft.title.trim().length === 0
}

/** `2020 · 256 pages · Harriman House`, skipping whatever Open Library didn't have. */
function metadataLine(draft: Draft): string | null {
  const parts = [
    draft.publishYear === null ? null : String(draft.publishYear),
    draft.pageCount === null ? null : `${draft.pageCount} pages`,
    draft.publisher,
  ].filter((part): part is string => Boolean(part))

  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Two of the three paths from SPEC §9 — Open Library search and manual entry. The third,
 * the barcode scanner, is M5 and joins the same form.
 *
 * Both paths end in the *same editable form* rather than creating a book outright.
 * Open Library metadata is frequently wrong, and the moment to fix it is before the
 * book exists, not after.
 */
export function AddBookSheet({
  uid,
  open,
  onOpenChange,
  onAdded,
  initialDraft = null,
}: AddBookSheetProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const cameraAvailable = useMemo(() => isCameraSupported(), [])

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
  const [draft, setDraft] = useState<Draft | null>(initialDraft)

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
      <SheetContent side="bottom" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{draft ? 'Add this book' : 'Add a book'}</SheetTitle>
          <SheetDescription>
            {!draft
              ? 'Search Open Library, or add it by hand.'
              : isScannedButUnknown(draft)
                ? // Says the barcode was read, so a blank form is not mistaken for a
                  // failed scan. The ISBN is kept either way.
                  'Barcode read, but Open Library doesn’t have this one. Add the title yourself.'
                : 'Check the details — you can change them now or later.'}
          </SheetDescription>
        </SheetHeader>

        {draft ? (
          <form onSubmit={submit} className="flex flex-col gap-4 px-4">
            {/*
              What the lookup found, shown rather than silently carried. A scan fetches a
              cover, a subtitle, a year, a page count and a publisher, and until now the
              form displayed none of it — so a correct scan and a scan of the wrong edition
              looked identical. Absent for manual entry, which has nothing to show.
            */}
            {/* `draft.isbn13` is in this condition on purpose: a scan Open Library could
                not resolve has no cover, no subtitle and no metadata line, and without it
                the one thing the scan *did* establish would be hidden. */}
            {draft.coverUrl || draft.subtitle || draft.isbn13 || metadataLine(draft) ? (
              <div className="flex gap-3">
                {draft.coverUrl ? (
                  <BookCover title={draft.title} coverUrl={draft.coverUrl} className="w-14 shrink-0" />
                ) : null}
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
                  {draft.subtitle ? (
                    <p className="text-muted-foreground line-clamp-2 text-sm">{draft.subtitle}</p>
                  ) : null}
                  {metadataLine(draft) ? (
                    <p className="text-muted-foreground text-xs">{metadataLine(draft)}</p>
                  ) : null}
                  {draft.isbn13 ? (
                    <p className="text-muted-foreground font-mono text-xs">{draft.isbn13}</p>
                  ) : null}
                </div>
              </div>
            ) : null}

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

            <div className="mt-1 flex flex-col gap-2">
              {/* The third path from SPEC §9. Hidden rather than disabled where there is
                  no camera at all — an unusable control is worse than an absent one. */}
              {cameraAvailable ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    void navigate('/scan', { state: { returnTo: location.pathname } })
                  }
                >
                  <ScanBarcode className="h-4 w-4" />
                  Scan barcode
                </Button>
              ) : null}

              {/* Always available, always the fallback — including when the search is
                  unreachable, which on a phone is a normal Tuesday. */}
              <Button type="button" variant="outline" onClick={() => setDraft(emptyDraft(trimmed))}>
                Add by hand
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
