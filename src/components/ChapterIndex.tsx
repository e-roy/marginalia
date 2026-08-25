import { chapterAnchor } from '@/lib/format'
import type { NoteWithId } from '@/lib/types'

interface ChapterIndexProps {
  /** Exactly the groups the notes column renders, so the two cannot disagree. */
  groups: { chapter: number | null; notes: NoteWithId[] }[]
  chapterTitles: Record<string, string>
}

/**
 * The desktop chapter index (`SPEC §8`, M7). Hidden below `lg`, where the chapter
 * headings are already on screen and this would just be a second copy of them.
 *
 * **Built from the rendered groups, not from `chapterTitles` or `currentChapter`.** Those
 * would each give a different list: a book can carry a title for a chapter it has no
 * notes in, and `currentChapter` says where the reader is rather than where the notes
 * are. Deriving from the same array the notes column maps over is what makes every link
 * land somewhere.
 *
 * **Unfiled gets an entry**, even though "Unfiled is not a chapter" everywhere else in
 * this app. It renders *first* in the notes column, so leaving it out would make the
 * topmost section the one thing the index could not reach.
 *
 * Plain anchors rather than `scrollIntoView`: they work without JavaScript, they are
 * focusable and announced, and there is no scroll position for anything to own. Nothing
 * highlights the chapter you are currently in — that would need an IntersectionObserver,
 * and it is not what this is for.
 */
export function ChapterIndex({ groups, chapterTitles }: ChapterIndexProps) {
  return (
    <nav aria-label="Chapters" className="hidden lg:sticky lg:top-6 lg:block lg:self-start">
      <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
        Chapters
      </p>

      <ul className="flex flex-col gap-0.5">
        {groups.map(({ chapter, notes }) => {
          const title = chapter === null ? null : (chapterTitles?.[String(chapter)] ?? null)

          return (
            <li key={chapterAnchor(chapter)}>
              <a
                href={`#${chapterAnchor(chapter)}`}
                className="hover:bg-accent/40 focus-visible:ring-ring/50 -mx-2 flex items-baseline gap-2 rounded-md px-2 py-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {chapter === null ? 'Unfiled' : `Chapter ${chapter}`}
                  </span>
                  {title ? (
                    <span className="text-muted-foreground block truncate text-xs italic">
                      {title}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {notes.length}
                </span>
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
