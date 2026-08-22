import { BrowserCodeReader, BrowserMultiFormatOneDReader } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import type { Draft } from '@/components/AddBookSheet'
import { Button } from '@/components/ui/button'
import { cameraMessage } from '@/lib/camera'
import { isValidIsbn13, normalizeIsbn13 } from '@/lib/isbn'
import { lookupIsbn } from '@/lib/openLibrary'

/**
 * The barcode path into the add-book form (`SPEC §9`).
 *
 * A route rather than a component inside the sheet, and lazily loaded: the decoder is
 * the largest dependency in the app and must never reach the capture bundle. Being a
 * route also means unmount is a real teardown point for the camera, which sheet-close
 * would not be.
 *
 * This screen does not create books. It produces a `Draft` and hands it back to
 * whichever screen opened it, because all three of `SPEC §9`'s paths end in the same
 * editable form.
 */

/** Throttles the decode loop. Continuous scanning is what eats battery, not the decode. */
const SCAN_ATTEMPT_INTERVAL_MS = 300

type Phase =
  | { kind: 'starting' }
  | { kind: 'scanning' }
  | { kind: 'looking-up' }
  | { kind: 'blocked'; message: string }

interface ScanLocationState {
  returnTo?: string
}

export function Scan() {
  const navigate = useNavigate()
  const location = useLocation()
  const returnTo = (location.state as ScanLocationState | null)?.returnTo ?? '/books'

  const videoRef = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })

  /**
   * Live scanner state kept outside React, for the same reason `capture.ts` keeps the
   * MediaRecorder outside it: these are handles and latches, not values to re-render on.
   *
   * `phaseRef` shadows `phase` because the `visibilitychange` listener and the decode
   * callback both need to read the *current* phase, and a listener registered once
   * would otherwise close over a stale one.
   */
  const controlsRef = useRef<{ stop: () => void } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const phaseRef = useRef<Phase['kind']>('starting')

  const toPhase = useCallback((next: Phase) => {
    phaseRef.current = next.kind
    setPhase(next)
  }, [])

  /**
   * Three calls, and only the middle one turns the camera off.
   *
   * `controls.stop()` ends the decode loop and nothing else. `cleanVideoSource()` nulls
   * `srcObject` — it detaches the element but never touches the tracks.
   * `releaseAllStreams()` is the one that calls `track.stop()`, which is what clears the
   * iOS camera indicator, exactly as `recorder.ts` records for the microphone. Dropping
   * it leaves the hardware live behind a navigation.
   *
   * `releaseAllStreams()` is global across ZXing's stream tracker, which is safe here
   * because this screen is the app's only ZXing consumer.
   */
  const teardown = useCallback(() => {
    controlsRef.current?.stop()
    controlsRef.current = null
    BrowserCodeReader.releaseAllStreams()
    if (videoRef.current) BrowserCodeReader.cleanVideoSource(videoRef.current)
  }, [])

  const onDecoded = useCallback(
    async (isbn13: string) => {
      // Stop the camera the moment we have something. The lookup can run for ten
      // seconds and there is no reason to keep the sensor live through it.
      teardown()
      toPhase({ kind: 'looking-up' })

      const controller = new AbortController()
      abortRef.current = controller

      let found = null
      try {
        found = await lookupIsbn(isbn13, controller.signal)
      } catch {
        // Not found, timed out and rate-limited all land in the same place: the form,
        // carrying the ISBN. The book is in the user's hands — the network is not
        // needed to name it (SPEC §9).
      }

      // The lookup outlives the screen if the user backs out mid-flight. Navigating
      // from here would then run against an unmounted route — the same shape as the
      // delete-redirect race in M4.
      if (!mountedRef.current) return

      const draft: Draft = {
        title: found?.title ?? '',
        authorsText: found?.authors.join(', ') ?? '',
        coverUrl: found?.coverUrl ?? null,
        openLibraryKey: found?.openLibraryKey ?? null,
        isbn13,
      }

      // `replace` so the scanner is not left in history: a back-swipe out of the
      // prefilled form must reach the shelf, not a live camera.
      void navigate(returnTo, { replace: true, state: { scannedDraft: draft } })
    },
    [navigate, returnTo, teardown, toPhase],
  )

  const start = useCallback(async () => {
    const video = videoRef.current
    if (!video || controlsRef.current) return

    const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]]])
    const reader = new BrowserMultiFormatOneDReader(hints, {
      delayBetweenScanAttempts: SCAN_ATTEMPT_INTERVAL_MS,
    })

    try {
      // `facingMode` as a plain value, not `exact`: an ideal constraint falls back to
      // whatever camera exists rather than throwing OverconstrainedError, which is what
      // makes this testable on a laptop with only a front camera.
      const controls = await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        video,
        (result) => {
          if (!result || phaseRef.current !== 'scanning') return

          const isbn13 = normalizeIsbn13(result.getText())
          // A misread that isn't a book barcode is silent — the loop simply keeps
          // scanning. Saying anything here would mean flashing an error at someone
          // slowly bringing a real barcode into frame.
          if (!isValidIsbn13(isbn13)) return

          void onDecoded(isbn13)
        },
      )

      if (!mountedRef.current) {
        controls.stop()
        BrowserCodeReader.releaseAllStreams()
        return
      }

      controlsRef.current = controls
      toPhase({ kind: 'scanning' })
    } catch (err) {
      if (!mountedRef.current) return
      toPhase({ kind: 'blocked', message: cameraMessage(err) })
    }
  }, [onDecoded, toPhase])

  useEffect(() => {
    mountedRef.current = true

    // Deferred by a microtask on purpose. `start` only sets state after awaiting
    // `decodeFromConstraints`, so nothing here ever rendered synchronously — but
    // `react-hooks/set-state-in-effect` can't see through the async boundary and reads
    // the direct call as a cascading render. That rule has caught a real bug in this
    // codebase before, so it gets an honest deferral rather than a disable comment.
    void Promise.resolve().then(start)

    /**
     * iOS suspends the stream when the app is backgrounded and does not reliably resume
     * it, so the camera is torn down and rebuilt around a trip to the home screen.
     *
     * The `scanning` guard is load-bearing. A successful scan has already stopped the
     * camera and is waiting on a lookup; without the guard, backgrounding during that
     * window would restart the camera just in time for the lookup to navigate away and
     * leave it running.
     */
    const onVisibility = () => {
      if (document.hidden) {
        if (phaseRef.current === 'scanning') teardown()
        return
      }
      if (phaseRef.current === 'scanning') void start()
    }

    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      mountedRef.current = false
      document.removeEventListener('visibilitychange', onVisibility)
      abortRef.current?.abort()
      teardown()
    }
  }, [start, teardown])

  return (
    // A fixed height, not a minimum, and explicitly non-scrolling: a viewfinder that
    // scrolls is a viewfinder you can lose. `--app-height` accounts for the safe-area
    // padding on `body` — plain `dvh` overflows it by the notch (see `index.css`).
    <div className="bg-background flex h-[var(--app-height)] flex-col overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-3">
        <Button variant="ghost" size="icon" onClick={() => void navigate(returnTo)} aria-label="Back">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-semibold">Scan a barcode</h1>
      </header>

      {phase.kind === 'blocked' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <p className="text-muted-foreground text-sm">{phase.message}</p>
          <Button variant="outline" onClick={() => void navigate(returnTo)}>
            Add the book by hand
          </Button>
        </div>
      ) : (
        <div className="relative flex-1 overflow-hidden bg-black">
          {/*
            `playsInline` is the one attribute this screen cannot do without: iOS Safari
            otherwise hoists the stream into its native fullscreen player and the
            viewfinder disappears. `muted` and `autoPlay` keep playback from needing a
            second gesture. Rendering the element ourselves — rather than letting ZXing
            create one — is the entire reason `decodeFromConstraints` is used here.
          */}
          {/*
            `absolute inset-0` rather than `h-full w-full`. A percentage height resolves
            against the parent's height, and this parent gets its height from `flex-1`
            growth — a *used* height, not a specified one. Safari resolves that
            unreliably, so the video fell back toward its own intrinsic aspect ratio and
            filled about half the screen on the phone while looking correct on desktop.
            Absolute positioning against the `relative` parent sidesteps the question.
          */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="absolute inset-0 h-full w-full object-cover"
          />

          {/* The guide box. Book barcodes are wide, so this is a letterbox rather than
              a square — it tells you how far away to hold the phone. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-28 w-[78%] rounded-lg border-2 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
          </div>

          <p className="absolute inset-x-0 bottom-8 text-center text-sm text-white/90">
            {phase.kind === 'looking-up' ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Looking it up…
              </span>
            ) : phase.kind === 'starting' ? (
              'Starting the camera…'
            ) : (
              'Point the camera at the barcode on the back'
            )}
          </p>
        </div>
      )}
    </div>
  )
}
