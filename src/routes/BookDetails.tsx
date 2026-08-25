import { ChevronLeft, Pencil } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { BookCover } from '@/components/BookCover'
import { ReadingScreen } from '@/components/ReadingScreen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useBook, useBooks } from '@/hooks/useLibrary'
import { updateBook } from '@/lib/books'
import type { BookWithId } from '@/lib/types'
import { useAuth } from '@/stores/auth'

/**
 * Everything the app knows about a book, on a screen of its own (`SPEC §9`).
 *
 * **Read-only until you ask to edit, which is a deliberate reversal.** Until 2026-08-25 all
 * of this sat at the top of the Book screen as always-live inputs, on the `SPEC §9`
 * reasoning that metadata is frequently wrong and you should never be stuck. Eric's point
 * on the day it shipped is the better reading of that: the rule justifies making a
 * correction *reachable*, not making every field *live*. A live text field above the notes
 * you came to read is a mis-tap away from silently rewriting a title that the scanner got
 * right — and a scanned book usually is right.
 *
 * So the Book screen keeps its identity block as plain text and gets on with the notes, and
 * corrections happen here, behind an explicit **Edit**, with a Save that commits and a
 * Cancel that does not.
 *
 * Reading status stays on the Book screen rather than moving here. It is a tab rather than a
 * text field, so it cannot be mistyped; a stray tap is visible and one tap undoes it; and
 * marking a book finished is a reading action you take *while* looking at its notes, not a
 * metadata correction.
 */

/** The form's own shape. Numbers stay strings while being typed. */
interface Draft {
  title: string
  subtitle: string
  authorsText: string
  publisher: string
  publishYear: string
  pageCount: string
  subjectsText: string
  isbn13: string
}

function draftFrom(book: BookWithId): Draft {
  return {
    title: book.title,
    subtitle: book.subtitle ?? '',
    authorsText: book.authors.join(', '),
    publisher: book.publisher ?? '',
    publishYear: book.publishYear === null ? '' : String(book.publishYear),
    pageCount: book.pageCount === null ? '' : String(book.pageCount),
    subjectsText: book.subjects.join(', '),
    isbn13: book.isbn13 ?? '',
  }
}

/**
 * A typed year or page count, or null for "not known". Tolerant of an empty field —
 * clearing one is how you say Open Library got it wrong — and intolerant of anything that
 * is not a positive number, so a half-typed value cannot land a `NaN` in Firestore.
 */
function numberOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** A labelled row, or nothing at all — an empty field is not worth a line. */
function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <div className="flex gap-4 py-1.5">
      <dt className="text-muted-foreground w-28 shrink-0 text-sm">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm">{value}</dd>
    </div>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  numeric,
  hint,
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  numeric?: boolean
  hint?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        name={id}
        value={value}
        inputMode={numeric ? 'numeric' : undefined}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-11 text-base"
      />
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  )
}

export function BookDetails() {
  const { bookId = null } = useParams()
  const uid = useAuth((s) => s.user?.uid ?? null)
  const books = useBooks(uid)
  const book = useBook(books, bookId)
  const navigate = useNavigate()

  /** Non-null is edit mode. Seeded from the book on entry, so Cancel is just dropping it. */
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  // The books subscription has not delivered yet, or the book is gone — the shelf is the
  // honest destination either way, and matches what the Book screen does.
  if (!uid) return <Navigate to="/" replace />
  if (!book) return books.length > 0 ? <Navigate to="/books" replace /> : null

  const backTo = `/books/${book.id}`

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft) return

    const title = draft.title.trim()
    if (title.length === 0) {
      toast.error('A book needs a title.')
      return
    }

    setSaving(true)
    try {
      await updateBook(uid, book.id, {
        title,
        subtitle: draft.subtitle.trim() || null,
        authors: commaList(draft.authorsText),
        publisher: draft.publisher.trim() || null,
        publishYear: numberOrNull(draft.publishYear),
        pageCount: numberOrNull(draft.pageCount),
        subjects: commaList(draft.subjectsText),
        isbn13: draft.isbn13.trim() || null,
      })
      setDraft(null)
      toast.success('Details saved.')
    } catch (err) {
      // Nothing was written, so the draft is still the user's work — keep them in edit mode
      // rather than dropping a form they may have spent a minute on.
      console.error('[marginalia] saving book details failed', err)
      toast.error("Couldn't save those details. Try again.")
    } finally {
      setSaving(false)
    }
  }

  const published = [
    book.publishYear === null ? null : String(book.publishYear),
    book.pageCount === null ? null : `${book.pageCount} pages`,
    book.publisher,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')

  return (
    <ReadingScreen>
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link to={backTo}>
            <ChevronLeft className="h-5 w-5" />
          </Link>
        </Button>
        <h1 className="line-clamp-1 flex-1 font-semibold">Details</h1>
        {draft ? null : (
          <Button variant="outline" size="sm" onClick={() => setDraft(draftFrom(book))}>
            <Pencil className="h-4 w-4" />
            Edit
          </Button>
        )}
      </header>

      <div className="flex gap-4">
        <BookCover title={book.title} coverUrl={book.coverUrl} className="w-24 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <p className="font-medium">{book.title}</p>
          {book.subtitle ? (
            <p className="text-muted-foreground text-sm">{book.subtitle}</p>
          ) : null}
          <p className="text-muted-foreground text-sm">
            {book.authors.join(', ') || 'Unknown author'}
          </p>
        </div>
      </div>

      {draft ? (
        <form onSubmit={save} className="flex flex-col gap-4">
          <Field
            id="details-title"
            label="Title"
            value={draft.title}
            onChange={(title) => setDraft({ ...draft, title })}
            placeholder="What are you reading?"
          />
          <Field
            id="details-subtitle"
            label="Subtitle"
            value={draft.subtitle}
            onChange={(subtitle) => setDraft({ ...draft, subtitle })}
            placeholder="Optional"
          />
          <Field
            id="details-authors"
            label="Author"
            value={draft.authorsText}
            onChange={(authorsText) => setDraft({ ...draft, authorsText })}
            placeholder="Optional"
            hint="Separate multiple authors with commas."
          />

          <div className="flex gap-2">
            <div className="w-24">
              <Field
                id="details-year"
                label="Year"
                value={draft.publishYear}
                onChange={(publishYear) => setDraft({ ...draft, publishYear })}
                numeric
              />
            </div>
            <div className="w-24">
              <Field
                id="details-pages"
                label="Pages"
                value={draft.pageCount}
                onChange={(pageCount) => setDraft({ ...draft, pageCount })}
                numeric
              />
            </div>
          </div>

          <Field
            id="details-publisher"
            label="Publisher"
            value={draft.publisher}
            onChange={(publisher) => setDraft({ ...draft, publisher })}
            placeholder="Optional"
          />
          <Field
            id="details-isbn"
            label="ISBN"
            value={draft.isbn13}
            onChange={(isbn13) => setDraft({ ...draft, isbn13 })}
            placeholder="Optional"
            numeric
          />
          <Field
            id="details-subjects"
            label="Subjects"
            value={draft.subjectsText}
            onChange={(subjectsText) => setDraft({ ...draft, subjectsText })}
            placeholder="Optional"
            hint="Separate subjects with commas."
          />

          <div className="flex flex-row gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDraft(null)}
              disabled={saving}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving} className="flex-1">
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <dl className="divide-border divide-y">
            <Row label="Published" value={published || null} />
            <Row label="ISBN" value={book.isbn13} />
            <Row label="Subjects" value={book.subjects.join(', ') || null} />
            <Row
              label="Notes"
              value={`${book.noteCount} note${book.noteCount === 1 ? '' : 's'}`}
            />
          </dl>

          {/* Every metadata field is empty on a book added by hand, and an empty screen
              with an Edit button in the corner does not say that loudly enough. */}
          {!published && !book.isbn13 && book.subjects.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing else recorded for this book yet. <strong>Edit</strong> to add it.
            </p>
          ) : null}

          <Button variant="outline" onClick={() => void navigate(backTo)}>
            Back to notes
          </Button>
        </>
      )}
    </ReadingScreen>
  )
}
