import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import type { Draft } from '@/components/AddBookSheet'

/**
 * Catches the draft the scanner hands back (`SPEC §9`).
 *
 * Both screens that mount `AddBookSheet` need this and differ only in what they do once
 * a book exists, so the catching half lives here rather than being written twice.
 *
 * Router state is the single source of truth — the draft is never copied into component
 * state. That keeps this out of a `useEffect` entirely: there is nothing to synchronize,
 * only something to read during render and to clear from an event handler.
 *
 * `key` is what makes the sheet accept the draft. `AddBookSheet` reads `initialDraft`
 * once, as the initial value of its own state, so the parent has to remount it — and a
 * key that changes with the draft is exactly that.
 */
export function useScannedDraft(): {
  draft: Draft | null
  key: string
  clear: () => void
} {
  const location = useLocation()
  const navigate = useNavigate()

  const draft = (location.state as { scannedDraft?: Draft } | null)?.scannedDraft ?? null

  /**
   * Called when the sheet closes. Without it the draft would still be sitting on this
   * history entry, and any re-render that recomputed "should the sheet be open" would
   * reopen it on a book the user has already dealt with.
   */
  const clear = useCallback(() => {
    if (!draft) return
    void navigate(location.pathname, { replace: true, state: null })
  }, [draft, location.pathname, navigate])

  return {
    draft,
    key: draft ? `scan-${draft.isbn13 ?? 'unknown'}` : 'blank',
    clear,
  }
}
