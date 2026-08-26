import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { initAuth } from '@/stores/auth'
import './index.css'

/**
 * A cold launch opens the shelf; a resume opens the record screen.
 *
 * `SPEC §8` said "opens ready to record" from the first draft, and for a single-book app
 * that was right. It stopped being right once the Now screen became about *one* book
 * (2026-08-25): opening cold onto whatever book was last selected means the app guesses,
 * and it guesses from a pointer that may be days old. Eric asked for the library instead —
 * pick what you are reading, then record.
 *
 * **Only a cold launch.** Resuming a backgrounded app must still land on the record
 * screen, because that is the case the whole design is for: you are mid-chapter, you have
 * a thought, you raise the phone. `sessionStorage` is exactly the right instrument — it is
 * scoped to the page session, so it is empty on a fresh document load and populated on
 * every later render of that same document. Backgrounding an installed PWA does not clear
 * it; iOS discarding the app and reloading the document does, which is correct, because
 * that *is* a relaunch.
 *
 * Done here, before React mounts, rather than as a redirect inside the router. Rewriting
 * the history entry means `BrowserRouter` reads `/books` as its initial location, so there
 * is no flash of the record screen and nothing to unwind. A `<Navigate>` would also have
 * had to survive `StrictMode`'s double render without consuming its own one-shot flag, and
 * would have re-fired every later navigation home.
 *
 * Only ever rewrites `/`. A deep link — a shared note, the scanner's return, an installed
 * shortcut — is a request for a specific screen and is left alone.
 */
function openOnLibraryWhenLaunchedCold(): void {
  if (window.location.pathname !== '/') return

  try {
    const KEY = 'marginalia.launched'
    const resumed = window.sessionStorage.getItem(KEY) !== null
    window.sessionStorage.setItem(KEY, '1')
    if (!resumed) window.history.replaceState(null, '', '/books')
  } catch {
    // iOS Safari throws on storage in some private-browsing states (ADR-010 hit the same
    // wall with `localStorage`). Falling through leaves the old behaviour — open on the
    // record screen — which is a far better failure than a crash before first paint.
  }
}

openOnLibraryWhenLaunchedCold()

initAuth()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
