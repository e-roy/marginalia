import { useEffect } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { toast } from 'sonner'

/**
 * The service worker is registered with `registerType: 'prompt'`, so a new build never
 * swaps itself in mid-session. That matters for a capture app: a silent reload while
 * a recording is queued would be a good way to lose it.
 */
export function UpdateToast() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      console.error('[marginalia] service worker registration failed', error)
    },
  })

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
