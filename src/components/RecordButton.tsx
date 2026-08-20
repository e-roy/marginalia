import { Loader2, Mic, Square } from 'lucide-react'

import { formatElapsed } from '@/lib/format'
import { MAX_DURATION_MS } from '@/lib/recorder'
import { cn } from '@/lib/utils'
import type { CaptureStatus } from '@/stores/capture'

/** Start warning once the cap is close enough that it could actually cut you off. */
const WARN_FROM_MS = MAX_DURATION_MS - 60_000

interface RecordButtonProps {
  status: CaptureStatus
  elapsedMs: number
  disabled: boolean
  onToggle: () => void
}

/**
 * One tap to start, one to stop — not hold-to-talk, because you may be holding a book
 * (SPEC §8). Hand-rolled rather than taken from the registry: nothing in shadcn is a
 * 96px push-to-record control, and wrapping a Button to look like this would be more
 * code than the button itself.
 */
export function RecordButton({ status, elapsedMs, disabled, onToggle }: RecordButtonProps) {
  const recording = status === 'recording'
  const busy = status === 'starting' || status === 'saving'

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled || busy}
        aria-label={recording ? 'Stop recording' : 'Start recording'}
        className={cn(
          'relative flex h-24 w-24 items-center justify-center rounded-full',
          'transition-colors duration-200 outline-none',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2',
          'disabled:opacity-50',
          recording
            ? 'bg-destructive text-white'
            : 'bg-primary text-primary-foreground active:brightness-95',
        )}
      >
        {/* A ring that keeps moving, so a pocket-recording is obvious at a glance. */}
        {recording ? (
          <span className="border-destructive/60 absolute inset-0 animate-ping rounded-full border-2" />
        ) : null}

        {busy ? (
          <Loader2 className="h-8 w-8 animate-spin" />
        ) : recording ? (
          <Square className="h-7 w-7 fill-current" />
        ) : (
          <Mic className="h-9 w-9" />
        )}
      </button>

      <div className="flex h-10 flex-col items-center justify-center">
        {recording ? (
          <>
            <p
              className="text-2xl font-semibold tabular-nums"
              aria-live="polite"
              aria-atomic="true"
            >
              {formatElapsed(elapsedMs)}
            </p>
            {elapsedMs >= WARN_FROM_MS ? (
              <p className="text-destructive text-xs">
                Stops automatically at {formatElapsed(MAX_DURATION_MS)}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            {status === 'saving' ? 'Saving…' : 'Tap to record'}
          </p>
        )}
      </div>
    </div>
  )
}
