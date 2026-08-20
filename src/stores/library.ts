import { create } from 'zustand'

import type { BookWithId } from '@/lib/types'

/**
 * Which book the Now screen is pointed at.
 *
 * This is deliberately device-local rather than a field on `settings/app`. It is a
 * resume pointer for one phone, not user data: two devices may be mid-different-book,
 * switching books shouldn't cost a Firestore write per tap, and nothing is lost if it
 * goes missing. Each book's own `currentChapter` *is* in Firestore, because that is
 * per-book state the stepper mutates and the Whisper prompt is built from.
 */

const STORAGE_KEY = 'marginalia.selectedBook'

/** iOS Safari throws on localStorage in some private-browsing states. Never fatal. */
function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(bookId: string | null): void {
  try {
    if (bookId === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, bookId)
  } catch {
    // A selection that doesn't survive a reload is a far smaller problem than a crash.
  }
}

interface LibraryState {
  selectedBookId: string | null
  select: (bookId: string | null) => void
}

export const useLibrary = create<LibraryState>((set) => ({
  selectedBookId: readStored(),
  select: (bookId) => {
    writeStored(bookId)
    set({ selectedBookId: bookId })
  },
}))

/**
 * The book the Now screen should actually use: the stored selection while it still
 * exists, and otherwise the most recently touched book. Falling back matters — the
 * stored id survives a book being deleted on another device, and an empty shelf has no
 * selection at all.
 */
export function resolveSelected(
  books: BookWithId[],
  selectedBookId: string | null,
): BookWithId | null {
  if (books.length === 0) return null
  const chosen = books.find((book) => book.id === selectedBookId)
  // `books` arrives most-recently-touched first, so index 0 is the fallback.
  return chosen ?? books[0] ?? null
}
