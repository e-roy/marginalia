/**
 * Platform checks. iOS Safari is the primary target and differs from every other
 * browser in ways that matter to this app — see CLAUDE.md and the vault's
 * Lessons Learned.
 */

/** True when running as an installed PWA rather than a browser tab. */
export function isStandalone(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) return true
  // iOS Safari predates the display-mode media query and uses this instead.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function isIos(): boolean {
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  // iPadOS 13+ reports as a Mac; the touch points give it away.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/**
 * Whether to nag about installing to the Home Screen.
 *
 * This matters more than it looks: Safari evicts site data after ~7 days of non-use,
 * and Home Screen apps are exempt. The IndexedDB upload queue lives in that data, so
 * an uninstalled iOS user can silently lose queued recordings.
 */
export function shouldPromptInstall(): boolean {
  return isIos() && !isStandalone()
}
