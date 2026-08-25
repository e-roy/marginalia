import type { ReactNode } from 'react'

/**
 * The container for the three screens you *read* on — Book, Note and Search (`SPEC §8`).
 *
 * Every route in this app spells its own container, and until M7 they all agreed:
 * `max-w-md`, 448px, centred. That is right for capture on a phone and absurd on a
 * monitor, where a book's notes became a 448px ribbon down the middle of 1440px.
 *
 * Only these three widen. Now, Books, Settings and Scan keep the phone layout at every
 * width and keep their own containers, because they are capture and management screens
 * where a wide line length buys nothing — and because a layout milestone should not
 * quietly become a six-route refactor.
 *
 * `--app-height` rather than `dvh`: `body` carries the safe-area padding and is
 * `border-box`, so a `100dvh` child overflows by the notch (`index.css`).
 */

interface ReadingScreenProps {
  /**
   * `prose` — one column at a comfortable measure, about 75 characters (Note, Search).
   * `wide` — room for the Book screen's chapter index beside its notes.
   */
  width?: 'prose' | 'wide'
  className?: string
  children: ReactNode
}

const WIDTHS: Record<'prose' | 'wide', string> = {
  prose: 'lg:max-w-2xl',
  wide: 'lg:max-w-5xl',
}

export function ReadingScreen({ width = 'prose', className, children }: ReadingScreenProps) {
  return (
    <div
      className={`mx-auto flex min-h-[var(--app-height)] w-full max-w-md flex-col gap-5 px-5 py-6 lg:px-8 ${WIDTHS[width]}${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  )
}
