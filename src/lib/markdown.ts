/**
 * Per-book Markdown with Obsidian frontmatter (`SPEC §11`), and the filename rules that
 * go with it.
 *
 * **This module imports nothing, and that is a constraint rather than an accident.** It
 * takes plain data — no `Timestamp`, no `NoteWithId`, no `@/` alias — so
 * `node --experimental-strip-types` can run it directly against a fixture and diff the
 * result against the sample printed at `SPEC.md:732–747`. Type-stripping erases type
 * imports but cannot resolve the alias, so a single value import from `@/lib/*` would put
 * the renderer out of reach of the one test that proves it. `export.ts` is the adapter
 * that turns Firestore documents into the shapes below.
 *
 * `resolveCollisions` lives here for the same reason and not in `export.ts`: it is pure
 * string logic whose absence silently *loses a file* (`Title.md` + `TITLE.md` extract to
 * one file on any case-insensitive filesystem), so it belongs where a test can call the
 * real thing rather than a hand-written stand-in.
 */

/** A book, reduced to what the frontmatter needs. */
export interface ExportBook {
  title: string
  authors: string[]
  isbn13: string | null
  /**
   * Added 2026-08-24, extending the format ADR-020 fixed. Each is omitted when absent, so
   * a book added by hand still produces exactly the frontmatter it did before.
   */
  subtitle: string | null
  publishYear: number | null
  pageCount: number | null
  publisher: string | null
  subjects: string[]
}

/**
 * One note, already resolved. `text` is what the reader sees — `export.ts` has run it
 * through `noteText()` — and the chapter title is looked up there too, because chapter
 * titles live on the *book* and this module never sees one.
 */
export interface ExportNote {
  chapter: number | null
  chapterTitle: string | null
  recordedAt: Date
  text: string
}

const pad = (value: number) => String(value).padStart(2, '0')

/**
 * `2026-08-14` and `09:41`, built by hand from local time.
 *
 * Deliberately not `formatClockTime` from `@/lib/format`, which is `toLocaleTimeString`
 * and would render `9:41 AM` on this machine and something else on a phone set to another
 * locale. A Markdown file is a durable artifact that outlives the browser that wrote it,
 * so its shape must not depend on where it was written. Local time rather than UTC because
 * the note is stamped when you spoke it, and 09:41 is when you were reading.
 */
function isoDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function clock24(value: Date): string {
  return `${pad(value.getHours())}:${pad(value.getMinutes())}`
}

/**
 * A double-quoted YAML scalar.
 *
 * Only `\` and `"` need escaping inside one, and a newline would end the scalar and break
 * the document — a book title carrying one is pathological but arrives from Open Library
 * metadata, which `SPEC §9` already says is frequently wrong. Obsidian fails to parse the
 * whole frontmatter block if any line is malformed, so the cost of getting this wrong is
 * every property on the note, not one.
 */
function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
  return `"${escaped}"`
}

/**
 * `## Chapter 12 — The Science of Availability`, `## Chapter 12`, or `## Unfiled`.
 * `SPEC §11`: untitled chapters export as just the number.
 */
function chapterHeading(chapter: number | null, title: string | null): string {
  if (chapter === null) return '## Unfiled'
  const trimmed = title?.trim() ?? ''
  return trimmed.length > 0 ? `## Chapter ${chapter} — ${trimmed}` : `## Chapter ${chapter}`
}

/**
 * Reading order: Unfiled first, then chapters ascending, and oldest first within each —
 * the same order the Book screen groups them in.
 *
 * Sorted here rather than trusted from the caller, so the file is identical whichever path
 * produced it. `useBookNotes` happens to arrive sorted; the export-all query does not.
 */
function inReadingOrder(notes: ExportNote[]): ExportNote[] {
  return [...notes].sort((a, b) => {
    if (a.chapter !== b.chapter) {
      if (a.chapter === null) return -1
      if (b.chapter === null) return 1
      return a.chapter - b.chapter
    }
    return a.recordedAt.getTime() - b.recordedAt.getTime()
  })
}

/**
 * One book as a Markdown document.
 *
 * The blocks are joined by a blank line and the file ends with a single newline, which is
 * exactly the shape of `SPEC §11`'s sample. **Prose is emitted verbatim** — the sample is
 * hard-wrapped only because it is printed inside a spec document, and re-wrapping a note
 * would corrupt text the user may have hand-edited.
 */
export function bookMarkdown(book: ExportBook, notes: ExportNote[], exportedOn: Date): string {
  const authors = book.authors.filter((name) => name.trim().length > 0).join(', ')

  // An absent key beats an empty one: `author: ""` is a property Obsidian will show as
  // blank, where omitting it leaves the note simply not claiming an author.
  const frontmatter = [
    '---',
    `title: ${yamlString(book.title)}`,
    ...(book.subtitle ? [`subtitle: ${yamlString(book.subtitle)}`] : []),
    ...(authors.length > 0 ? [`author: ${yamlString(authors)}`] : []),
    ...(book.isbn13 ? [`isbn: ${yamlString(book.isbn13)}`] : []),
    ...(book.publisher ? [`publisher: ${yamlString(book.publisher)}`] : []),
    // Bare numbers, so Obsidian types them as numbers rather than as text you cannot sort.
    ...(book.publishYear === null ? [] : [`year: ${book.publishYear}`]),
    ...(book.pageCount === null ? [] : [`pages: ${book.pageCount}`]),
    /**
     * A flow sequence of **quoted** scalars, unlike `tags` below.
     *
     * `tags: [book-notes]` is a fixed literal that is safe bare. A subject is arbitrary
     * text off Open Library, and the live data contains commas inside single subjects —
     * `77.32 intelligence, creativity` — which a bare flow sequence would silently split
     * into two entries. A colon or a quote would be worse: ADR-020 records that Obsidian
     * discards the *whole* frontmatter block when any line is malformed, so the cost of
     * getting this wrong is every property on the file.
     */
    ...(book.subjects.length > 0
      ? [`subjects: [${book.subjects.map(yamlString).join(', ')}]`]
      : []),
    // Not quoted, matching the spec: a flow sequence and a bare ISO date are both valid
    // YAML unquoted, and Obsidian renders the first as a real tag list only in that form.
    'tags: [book-notes]',
    `exported: ${isoDate(exportedOn)}`,
    '---',
  ].join('\n')

  const blocks: string[] = [frontmatter, `# ${book.title}`]

  let openChapter: number | null | undefined
  for (const note of inReadingOrder(notes)) {
    if (openChapter === undefined || note.chapter !== openChapter) {
      blocks.push(chapterHeading(note.chapter, note.chapterTitle))
      openChapter = note.chapter
    }
    blocks.push(`**${isoDate(note.recordedAt)} · ${clock24(note.recordedAt)}**`)
    blocks.push(note.text)
  }

  return `${blocks.join('\n\n')}\n`
}

/**
 * Windows device names, which are reserved with or without an extension — `CON.md` is as
 * unopenable as `CON`. Checked against the segment before the first dot, which is where
 * the rule actually applies.
 */
const RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Illegal on Windows; `/` would also make a path segment on every other system. `\p{Cc}`
 * covers the control characters, written as a Unicode property rather than a literal
 * `\x00-\x1F` range because that range trips ESLint's `no-control-regex`.
 *
 * Spaces are deliberately NOT in here. A book title is mostly spaces, and
 * `Thinking,-Fast-and-Slow` would be a worse filename than the problem it solved.
 */
const ILLEGAL = /[<>:"/\\|?*\p{Cc}]/gu

/**
 * A book title as a filename.
 *
 * Sanitized for the strictest filesystem the file might land on rather than the one that
 * wrote it — these files exist to be moved into an Obsidian vault, which may well be on a
 * different machine than the browser that exported them.
 */
export function exportFilename(title: string): string {
  let stem = title
    .replace(ILLEGAL, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 100)
    // After the slice, so a truncation landing mid-space cannot leave a trailing one —
    // Windows silently strips trailing dots and spaces, which turns two distinct names
    // into one collision that never reaches `resolveCollisions`.
    .replace(/^[.\s-]+|[.\s-]+$/g, '')

  if (stem.length === 0) stem = 'Untitled book'
  if (RESERVED_STEM.test(stem.split('.')[0] ?? '')) stem = `_${stem}`

  return `${stem}.md`
}

/**
 * Make a list of filenames unique **case-insensitively** — `Title.md`, `Title (2).md`.
 *
 * Case-insensitively because that is what the extracting filesystem does. Measured: an
 * archive containing both `Title.md` and `TITLE.md` extracts to a *single* file holding
 * the second entry's body, with the first silently gone. Two books whose titles differ
 * only in capitalisation is not a contrived case — it is one book added twice, once from
 * a barcode scan and once by hand.
 */
export function resolveCollisions(names: string[]): string[] {
  const taken = new Set<string>()

  return names.map((name) => {
    const dot = name.lastIndexOf('.')
    const stem = dot === -1 ? name : name.slice(0, dot)
    const extension = dot === -1 ? '' : name.slice(dot)

    let candidate = name
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
      candidate = `${stem} (${n})${extension}`
    }

    taken.add(candidate.toLowerCase())
    return candidate
  })
}
