import { highlightParts } from '@/lib/search'

/**
 * Text with the search terms marked.
 *
 * Shared by the Search screen and the Book screen's in-book filter, because a filtered
 * list that does not show *why* each row matched is a list you have to re-read.
 *
 * `<mark>` elements built from an array, never `dangerouslySetInnerHTML` — the terms come
 * from whatever the user typed, and the note text is theirs too, so neither should ever
 * be parsed as HTML.
 */
export function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>

  return (
    <>
      {highlightParts(text, terms).map((part, i) =>
        // `String.split` with a capture group alternates plain, matched, plain — so the
        // odd indices are the matches.
        i % 2 === 1 ? (
          <mark key={i} className="bg-accent text-accent-foreground rounded-sm px-0.5">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  )
}
