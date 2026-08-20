import { create } from 'zustand'

import { countAudio } from '@/lib/audioQueue'
import { createVoiceNote, flushQueue, type NoteTarget } from '@/lib/notes'
import {
  startRecording,
  type AutoStopReason,
  type RecordingHandle,
} from '@/lib/recorder'

export type CaptureStatus = 'idle' | 'starting' | 'recording' | 'saving'

interface CaptureState {
  status: CaptureStatus
  elapsedMs: number
  /** Recordings still on the device, waiting for a network. */
  queuedCount: number
  /** Sanitized and safe to render. */
  error: string | null
  lastAutoStop: AutoStopReason | null

  toggle: (uid: string, book: NoteTarget) => Promise<void>
  refreshQueue: (uid: string) => Promise<void>
  flush: (uid: string) => Promise<void>
  dismissError: () => void
}

/**
 * Recorder state that must survive a re-render lives outside the store, because it is
 * not state React should be diffing — it is a live MediaRecorder and its timers.
 */
let handle: RecordingHandle | null = null
let ticker: ReturnType<typeof setInterval> | undefined
let context: { uid: string; book: NoteTarget } | null = null

function microphoneMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow it in Settings, then try again.'
  }
  if (name === 'NotFoundError') return 'No microphone was found on this device.'
  if (err instanceof Error && err.message === 'recording-unsupported') {
    return "This browser can't record audio."
  }
  return "Couldn't start recording. Try again."
}

/**
 * Stops the recorder and files the note. Reached two ways — the user tapping stop, and
 * the recorder auto-stopping at the cap or because iOS backgrounded the app — so it
 * guards against running twice.
 */
async function finishRecording(): Promise<void> {
  const current = handle
  const ctx = context
  if (!current || !ctx) return

  handle = null
  context = null
  clearInterval(ticker)
  useCapture.setState({ status: 'saving' })

  try {
    const recording = await current.stop()

    if (recording.blob.size === 0) {
      useCapture.setState({ error: 'That recording came back empty. Try again.' })
      return
    }

    await createVoiceNote(ctx.uid, recording, ctx.book)
    await useCapture.getState().refreshQueue(ctx.uid)

    // Not awaited: the note is already on screen and the upload is a background job.
    void useCapture.getState().flush(ctx.uid)
  } catch (err) {
    console.error('[marginalia] failed to save recording', err)
    useCapture.setState({ error: "Couldn't save that recording." })
  } finally {
    useCapture.setState({ status: 'idle', elapsedMs: 0 })
  }
}

export const useCapture = create<CaptureState>((set, get) => ({
  status: 'idle',
  elapsedMs: 0,
  queuedCount: 0,
  error: null,
  lastAutoStop: null,

  toggle: async (uid, book) => {
    const { status } = get()

    if (status === 'recording') {
      await finishRecording()
      return
    }
    if (status !== 'idle') return // starting or saving — ignore the double tap

    set({ status: 'starting', error: null, lastAutoStop: null })
    try {
      context = { uid, book }
      handle = await startRecording((reason) => {
        set({ lastAutoStop: reason })
        void finishRecording()
      })
      set({ status: 'recording', elapsedMs: 0 })

      // 200ms is smooth enough for a seconds counter without waking the phone up for
      // no reason.
      ticker = setInterval(() => {
        if (handle) set({ elapsedMs: Date.now() - handle.startedAt })
      }, 200)
    } catch (err) {
      context = null
      set({ status: 'idle', error: microphoneMessage(err) })
    }
  },

  refreshQueue: async (uid) => {
    try {
      set({ queuedCount: await countAudio(uid) })
    } catch (err) {
      console.warn('[marginalia] could not read the audio queue', err)
    }
  },

  flush: async (uid) => {
    await flushQueue(uid)
    await get().refreshQueue(uid)
  },

  dismissError: () => set({ error: null }),
}))

/**
 * iOS has no Background Sync, so the queue is drained from every trigger that exists
 * instead: app launch, returning to the foreground, and regaining a network (SPEC §4).
 * Returns its own teardown so the caller's effect can clean up on sign-out.
 */
export function initCapture(uid: string): () => void {
  const flush = () => void useCapture.getState().flush(uid)

  const onVisibility = () => {
    if (!document.hidden) flush()
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', flush)
  flush()

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('online', flush)
  }
}
