import { BrowserCodeReader, BrowserMultiFormatOneDReader } from '@zxing/browser'
import { BarcodeFormat, DecodeHintType } from '@zxing/library'
import { ChevronLeft, Keyboard, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import type { Draft } from '@/components/AddBookSheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  /** Carries the number so the screen can show what it is looking up. */
  | { kind: 'looking-up'; isbn13: string }
  | { kind: 'blocked'; message: string }
  /**
   * Typing the number printed under the barcode. Reachable from `scanning` — some books
   * simply will not decode — and from `blocked`, which is the state where a decode is
   * impossible by construction and where the only previous option was to give up and go
   * looking for the book by title.
   */
  | { kind: 'manual' }

interface ScanLocationState {
  returnTo?: string
}

export function Scan() {
  const navigate = useNavigate()
  const location = useLocation()
  const returnTo = (location.state as ScanLocationState | null)?.returnTo ?? '/books'

  const videoRef = useRef<HTMLVideoElement>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })

  /** Local to this screen and to this attempt — nothing else has any use for either. */
  const [typedIsbn, setTypedIsbn] = useState('')
  const [typedError, setTypedError] = useState<string | null>(null)

  /**
   * The last camera frame, held as a still while the lookup runs.
   *
   * The camera is stopped the instant a barcode decodes, which is right — the lookup can run
   * for twelve seconds and there is no reason to keep the sensor live through it. But it left
   * the viewfinder as a **black rectangle** with the guide box still drawn over nothing, which
   * reads as the camera having died rather than as work in progress. Freezing the frame keeps
   * the book on screen and doubles as confirmation of what was actually read.
   *
   * Null on the manual-entry path, where there is no frame to keep — the overlay below simply
   * falls back to the dim background.
   */
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null)

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
      // Grab the frame *before* the teardown nulls `srcObject`, or there is nothing left to
      // draw. One canvas readback on a successful scan — not the per-attempt cost that made
      // `TRY_HARDER` unaffordable, and it happens once rather than several times a second.
      const video = videoRef.current
      let frame: string | null = null
      if (video?.videoWidth) {
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const context = canvas.getContext('2d')
        if (context) {
          context.drawImage(video, 0, 0)
          frame = canvas.toDataURL('image/jpeg', 0.7)
        }
      }

      // Stop the camera the moment we have something. The lookup can run for twelve
      // seconds and there is no reason to keep the sensor live through it.
      teardown()
      setFrozenFrame(frame)
      toPhase({ kind: 'looking-up', isbn13 })

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
        subtitle: found?.subtitle ?? null,
        publishYear: found?.firstPublishYear ?? null,
        pageCount: found?.pageCount ?? null,
        publisher: found?.publisher ?? null,
        subjects: found?.subjects ?? [],
        subjectPeople: found?.subjectPeople ?? [],
        description: found?.description ?? null,
        tableOfContents: found?.tableOfContents ?? [],
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

    /**
     * **`TRY_HARDER` was tried here on 2026-08-24 and reverted the same day. Do not put it
     * back without hand-driving the decode loop first.**
     *
     * The headless benchmark (`scripts/decode-bench.mjs`) liked it a lot: it won or tied 26
     * cells to 7, and it took a vertically-held book from a 0% decode rate to 100%, which is
     * a capability rather than a tuning gain. On a real iPhone it made the viewfinder go
     * **black** — the camera flashes once and the page never paints again.
     *
     * The benchmark could not see it, and the reason is worth keeping. `TRY_HARDER` does two
     * things in `OneDReader`: `maxLines` goes from a fixed 25 rows to the whole frame (~360
     * rows at 720p, doubled for the reversed pass), and `decode` gains a rotated-90° retry
     * that runs that entire scan a second time. The retry calls
     * `HTMLCanvasElementLuminanceSource.rotateCounterClockwise()`, which is **not** an array
     * transpose: it resizes a temp canvas, does a rotated `drawImage`, then re-runs
     * `getImageData` over the whole frame and rebuilds the greyscale buffer. Two full-frame
     * GPU readbacks and ~14× the row work, on every failed attempt — which is every attempt
     * while someone is still lining the barcode up.
     *
     * The benchmark substituted a cheap typed-array transpose for that call, so its timings
     * were optimistic in precisely the path that mattered. Desktop Node said 40-100 ms; the
     * phone said "black screen". That gap is the lesson, not the hint.
     *
     * **No resolution is requested either, and that one is a measured decision that stands.**
     * Raising the stream to 1280 or 1920 did not help, and under low light with sensor grain
     * it made things markedly worse: `HybridBinarizer` thresholds on 8×8 blocks, so once a
     * module is ~12 px wide a block sits inside a single bar with no dynamic range to work
     * with. Cropping to the guide box is the lever that would help — it raises px/module
     * while *lowering* the pixel count, and it is also what would make `TRY_HARDER`
     * affordable — but it needs the decode loop hand-driven, which ADR-014's camera
     * lifecycle makes a separate piece of work.
     */
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

  /**
   * The camera goes off on the way in. The software keyboard covers the viewfinder anyway,
   * and leaving the sensor live behind a form is the same waste `teardown` exists to
   * prevent — with the iOS camera indicator lit the whole time someone types thirteen
   * digits.
   */
  const openManual = useCallback(() => {
    teardown()
    setTypedError(null)
    toPhase({ kind: 'manual' })
  }, [teardown, toPhase])

  /**
   * And back out again. `start()` decides what "back" actually means: it succeeds and we
   * are scanning, or it fails and `cameraMessage` puts us right back in `blocked`. That
   * matters because manual entry is reachable *from* `blocked` — where the camera was
   * denied — and there is no camera to return to. Re-deriving the state is honest where
   * remembering the previous one would promise a viewfinder that cannot exist.
   */
  const closeManual = useCallback(() => {
    toPhase({ kind: 'starting' })
    void start()
  }, [start, toPhase])

  const submitManual = useCallback(
    (event: FormEvent) => {
      event.preventDefault()
      const isbn13 = normalizeIsbn13(typedIsbn)

      // A misread from the camera is rejected silently, because the person is still
      // bringing the barcode into frame and an error would be noise. A number someone
      // deliberately typed is the opposite case: saying nothing reads as a broken button.
      if (!isValidIsbn13(isbn13)) {
        setTypedError(
          "That isn't a book ISBN. It's the 13 digits under the barcode, usually starting 978.",
        )
        return
      }

      void onDecoded(isbn13)
    },
    [onDecoded, typedIsbn],
  )

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

      {/*
          The viewfinder is mounted in **every** phase, and that is load-bearing rather than
          tidy. `start()` early-returns on `!videoRef.current`, so a `blocked` branch that
          rendered its own subtree left no `<video>` to come back to — and manual entry is
          reachable from `blocked`. Overlaying the states on one persistent element means
          "back" is a plain `start()` call with nothing to remount first.
        */}
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

          {phase.kind === 'blocked' ? (
            <div className="bg-background absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
              <p className="text-muted-foreground text-sm">{phase.message}</p>
              {/* First, not second: the book is in your hands and its number is printed on
                  the back, so typing it is a better answer than going to look for the title
                  — and this is the one state where no amount of aiming will ever work. */}
              <Button variant="outline" onClick={openManual}>
                <Keyboard className="h-4 w-4" />
                Type the ISBN instead
              </Button>
              <Button variant="ghost" onClick={() => void navigate(returnTo)}>
                Add the book by hand
              </Button>
            </div>
          ) : phase.kind === 'manual' ? (
            // Anchored to the top rather than centred: iOS overlays the software keyboard
            // on the layout viewport instead of shrinking it, so a vertically centred form
            // is a form behind the keyboard.
            <div className="bg-background absolute inset-0 flex flex-col justify-start px-6 pt-6">
              <form onSubmit={submitManual} className="flex flex-col gap-3">
                <label htmlFor="manual-isbn" className="text-sm font-medium">
                  ISBN
                </label>
                <Input
                  id="manual-isbn"
                  name="manual-isbn"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="off"
                  value={typedIsbn}
                  onChange={(event) => {
                    setTypedIsbn(event.target.value)
                    setTypedError(null)
                  }}
                  placeholder="978…"
                  className="h-11 font-mono text-base"
                />
                <p className="text-muted-foreground text-xs">
                  The thirteen digits printed under the barcode. Spaces and hyphens are fine.
                </p>
                {typedError ? <p className="text-destructive text-sm">{typedError}</p> : null}

                <div className="flex gap-2">
                  <Button type="button" variant="ghost" onClick={closeManual} className="flex-1">
                    Back
                  </Button>
                  <Button
                    type="submit"
                    disabled={typedIsbn.trim().length === 0}
                    className="flex-1"
                  >
                    Look it up
                  </Button>
                </div>
              </form>
            </div>
          ) : phase.kind === 'looking-up' ? (
            /*
              The scan worked and the network is now the slow part — so say so, over the
              frame that was just read rather than over a black rectangle. The guide box is
              deliberately gone: there is nothing left to aim, and leaving it up implies the
              camera is still running.
            */
            <>
              {frozenFrame ? (
                <img
                  src={frozenFrame}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : null}

              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/65 px-8 text-center">
                <Loader2 className="h-7 w-7 animate-spin text-white" />
                <p className="text-white">Looking up this book…</p>
                {/* The number is the proof the scan succeeded, which matters most in the
                    case where the lookup is about to come back with nothing. */}
                <p className="font-mono text-sm tracking-wide text-white/70">{phase.isbn13}</p>
              </div>
            </>
          ) : (
            <>
              {/* The guide box. Book barcodes are wide, so this is a letterbox rather than
                  a square — it tells you how far away to hold the phone. */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="h-28 w-[78%] rounded-lg border-2 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
              </div>

              <p className="absolute inset-x-0 bottom-20 text-center text-sm text-white/90">
                {phase.kind === 'starting'
                  ? 'Starting the camera…'
                  : 'Point the camera at the barcode on the back'}
              </p>

              <div className="absolute inset-x-0 bottom-6 flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={openManual}
                  className="bg-white/15 text-white hover:bg-white/25"
                >
                  <Keyboard className="h-4 w-4" />
                  Type the ISBN instead
                </Button>
              </div>
            </>
          )}
      </div>
    </div>
  )
}
