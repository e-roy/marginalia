/**
 * Camera access for the barcode scanner (SPEC §9).
 *
 * The mirror of `microphoneMessage()` in `src/stores/capture.ts`, and it exists for the
 * same reason: on iOS a denial arrives with no prompt and no actionable default advice.
 */

import { isIos } from '@/lib/platform'

export function isCameraSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia)
}

export function cameraMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : ''

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    /**
     * Exactly the trap the microphone hit on the phone: a *global* default of Deny in
     * Settings › Safari › Camera governs installed web apps too, shows no prompt at
     * all, and is indistinguishable on screen from a per-app denial — while being far
     * easier to fix. Naming the setting is the whole value of this message; "allow it
     * in your browser settings" is advice an installed iOS app cannot act on.
     */
    if (isIos()) {
      return 'Camera blocked. Check Settings › Safari › Camera is set to Ask, then open the scanner again.'
    }
    return 'Camera access is blocked. Allow it in your browser settings, then try again.'
  }

  if (name === 'NotFoundError') return 'No camera was found on this device.'

  // No microphone analogue for this one: another app holding the camera is a normal
  // iOS occurrence, and it resolves by closing that app rather than by changing a
  // setting — so it must not be reported as a permission problem.
  if (name === 'NotReadableError') {
    return 'The camera is in use by another app. Close it and open the scanner again.'
  }

  return "Couldn't start the camera. Try again, or add the book by hand."
}
