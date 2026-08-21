import { useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { toast } from 'sonner'

/**
 * The service worker is registered with `registerType: 'prompt'`, so a new build never
 * swaps itself in mid-session. That matters for a capture app: a silent reload while
 * a recording is queued would be a good way to lose it.
 */

/**
 * Backstop only. The real trigger is `visibilitychange` below — deploying means going to
 * the computer, which backgrounds the app, so foregrounding it is the moment a check is
 * both wanted and free. This interval exists for a phone left staring at the screen, and
 * is deliberately slow because each check is a network round trip on a battery.
 */
const UPDATE_INTERVAL_MS = 5 * 60_000

export function UpdateToast() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null)

  const {
    needRefresh: [needRefresh, setNeedRefresh],
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
   * for a very long time, and the only cure is force-quitting it. `/sw.js` is served
   * `no-cache` (see `firebase.json`), so a check here really does reach the network
   * rather than confirming what we already had.
   */
  useEffect(() => {
    if (!registration) return

    const check = () => {
      if (document.visibilityState !== 'visible') return
      // Offline, or the server is unreachable. Nothing to do — the next check covers it,
      // and an update failing is never worth a message.
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

  useEffect(() => {
    if (!needRefresh) return
    toast('A new version is ready', {
      duration: Infinity,
      action: {
        label: 'Reload',
        onClick: () => void updateServiceWorker(true),
      },
      onDismiss: () => setNeedRefresh(false),
    })
  }, [needRefresh, setNeedRefresh, updateServiceWorker])

  return null
}
