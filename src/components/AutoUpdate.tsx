import { useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

import { useCapture } from '@/stores/capture'

/**
 * Applies a new build on its own, as soon as doing so is harmless.
 *
 * This used to be a toast with a Reload button, on the reasoning that a silent reload
 * "while a recording is queued would be a good way to lose it". That reasoning was
 * wrong: the queue lives in IndexedDB (`lib/audioQueue.ts`) and survives a reload
 * intact, as does the Firestore cache, the selected book, and the route. So the button
 * was guarding almost nothing, while costing a small tap target on a phone and leaving
 * the app one ignored toast away from running an old build indefinitely.
 *
 * What genuinely cannot survive a reload is a recording *in progress* — a live
 * MediaRecorder and its chunks exist only in memory — and text someone is part-way
 * through typing. Both are waited for rather than interrupted.
 *
 * `registerType` stays `'prompt'` in `vite.config.ts`. That is what keeps the new worker
 * waiting instead of activating itself, which is precisely what makes the gate below
 * possible: 'autoUpdate' would reload mid-recording.
 */

/** How often to re-check when an update is ready but the moment isn't. */
const RETRY_MS = 5_000

/** Backstop for a phone left foregrounded; `visibilitychange` is the real trigger. */
const UPDATE_INTERVAL_MS = 5 * 60_000

function safeToReload(): boolean {
  if (document.visibilityState !== 'visible') return false

  // Recording, about to record, or writing the note out. None of it is on disk yet.
  if (useCapture.getState().status !== 'idle') return false

  // Mid-sentence in the type-a-note sheet or a book field. Cheap to check, and losing
  // someone's half-written thought to a background update would be a poor trade.
  const el = document.activeElement
  if (
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  ) {
    return false
  }

  return true
}

export function AutoUpdate() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, swRegistration) {
      setRegistration(swRegistration ?? null)
    },
    onRegisterError(error) {
      console.error('[marginalia] service worker registration failed', error)
    },
  })

  /**
   * Ask whether a new build exists.
   *
   * Without this the browser only looks when the page navigates, plus once a day for a
   * long-lived one — so an installed PWA sitting in the app switcher can miss a deploy
   * for a very long time. `/sw.js` is served `no-cache` (see `firebase.json`), so a
   * check here really does reach the network.
   */
  useEffect(() => {
    if (!registration) return

    const check = () => {
      if (document.visibilityState !== 'visible') return
      // Offline, or the server is unreachable. The next check covers it.
      void registration.update().catch(() => {})
    }

    check()
    const timer = setInterval(check, UPDATE_INTERVAL_MS)
    document.addEventListener('visibilitychange', check)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [registration])

  /** A build is waiting. Take it at the first moment nothing would be lost. */
  useEffect(() => {
    if (!needRefresh) return

    const apply = () => {
      if (safeToReload()) void updateServiceWorker(true)
    }

    apply()

    // Recording finishing is the common unblock, so react to it directly rather than
    // waiting out the interval.
    const unsubscribe = useCapture.subscribe(apply)
    const timer = setInterval(apply, RETRY_MS)
    document.addEventListener('visibilitychange', apply)

    return () => {
      unsubscribe()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', apply)
    }
  }, [needRefresh, updateServiceWorker])

  return null
}
