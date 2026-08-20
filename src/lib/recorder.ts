/**
 * MediaRecorder, wrapped in the handful of behaviours iOS forces on us.
 *
 * Tap to start, tap to stop — not hold-to-talk, because you may be holding a book.
 */

export interface RecordingFormat {
  mime: string
  ext: string
}

/**
 * Safari's MediaRecorder does **not** produce webm; it gives `audio/mp4` (AAC). The
 * extension has to match the real container because Whisper sniffs it from the
 * filename, so the two travel together (SPEC §12).
 */
const CANDIDATES: RecordingFormat[] = [
  { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' }, // Safari / iOS — primary
  { mime: 'audio/webm;codecs=opus', ext: 'webm' }, // Chrome, Firefox
  { mime: 'audio/mp4', ext: 'm4a' },
]

/**
 * Ample for speech — Whisper resamples to 16 kHz mono anyway — and it keeps a
 * ten-minute note near 2.4 MB, which matters on mobile data.
 */
const AUDIO_BITS_PER_SECOND = 32_000

/**
 * The Cloudflare Tunnel cuts responses at roughly 100 seconds. A ten-minute note
 * transcribes in about a minute on Apple Silicon — comfortable, not unlimited
 * (SPEC §12). Hence a hard cap rather than a warning.
 */
export const MAX_DURATION_MS = 10 * 60 * 1000

export type AutoStopReason = 'cap' | 'hidden'

export interface Recording {
  blob: Blob
  format: RecordingFormat
  durationMs: number
  /** Client clock at the moment recording began — the timestamp that means something. */
  recordedAt: Date
  /** Set when the cap or a backgrounded app ended this, rather than the user. */
  autoStoppedBy: AutoStopReason | null
}

export interface RecordingHandle {
  format: RecordingFormat
  startedAt: number
  /** Idempotent — safe to call after an auto-stop has already fired. */
  stop: () => Promise<Recording>
}

export function pickFormat(): RecordingFormat | null {
  if (typeof MediaRecorder === 'undefined') return null
  return CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate.mime)) ?? null
}

export function isRecordingSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && pickFormat() !== null
}

export async function startRecording(
  onAutoStop: (reason: AutoStopReason) => void,
): Promise<RecordingHandle> {
  const format = pickFormat()
  if (!format) throw new Error('recording-unsupported')

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const recorder = new MediaRecorder(stream, {
    mimeType: format.mime,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  })

  const chunks: Blob[] = []
  const startedAt = Date.now()
  const recordedAt = new Date(startedAt)

  let autoStoppedBy: AutoStopReason | null = null
  let wakeLock: WakeLockSentinel | null = null
  let capTimer: ReturnType<typeof setTimeout> | undefined
  let cleanedUp = false

  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    clearTimeout(capTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    void wakeLock?.release().catch(() => {})
    wakeLock = null
    // Releasing the tracks is what clears the recording indicator on iOS. Without it
    // the mic stays live and the phone keeps telling you so.
    stream.getTracks().forEach((track) => track.stop())
  }

  const finish = (reason: AutoStopReason) => {
    if (recorder.state === 'inactive') return
    autoStoppedBy = reason
    recorder.stop()
    onAutoStop(reason)
  }

  /**
   * Recording stops when the PWA is backgrounded — iOS gives us no say in it. Stopping
   * cleanly keeps the partial note instead of losing the whole thing.
   */
  function onVisibility() {
    if (document.hidden) finish('hidden')
  }

  const settled = new Promise<Recording>((resolve, reject) => {
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    })
    recorder.addEventListener('stop', () => {
      cleanup()
      resolve({
        blob: new Blob(chunks, { type: format.mime }),
        format,
        durationMs: Date.now() - startedAt,
        recordedAt,
        autoStoppedBy,
      })
    })
    recorder.addEventListener('error', () => {
      cleanup()
      reject(new Error('recording-failed'))
    })
  })

  capTimer = setTimeout(() => finish('cap'), MAX_DURATION_MS)
  document.addEventListener('visibilitychange', onVisibility)

  // Held only while recording and released immediately after (SPEC §12). If the
  // recording ended before the request resolved, release it straight away.
  void navigator.wakeLock
    ?.request('screen')
    .then((sentinel) => {
      if (cleanedUp) void sentinel.release().catch(() => {})
      else wakeLock = sentinel
    })
    .catch(() => {
      // Wake Lock is best-effort; a denied lock is not a reason to fail a recording.
    })

  recorder.start()

  return {
    format,
    startedAt,
    stop: () => {
      if (recorder.state !== 'inactive') recorder.stop()
      return settled
    },
  }
}
