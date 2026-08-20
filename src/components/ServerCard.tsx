import { Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { checkServerHealth } from '@/lib/notes'
import type { ServerHealth } from '@/lib/types'

/**
 * Model discovery, surfaced. Nothing here is hardcoded and nothing can be: the server
 * only serves what is in its `PRELOAD_MODELS`, and nothing downloads on demand (SPEC §5).
 *
 * Which model actually gets used is deliberately *not* shown — it is recorded on each
 * note as `sttModel` after the fact, so the auto-pick is proved by a real transcript
 * rather than by a second copy of the picking logic living in the client.
 */
export function ServerCard() {
  const [health, setHealth] = useState<ServerHealth | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = async () => {
    setChecking(true)
    setError(null)
    try {
      setHealth(await checkServerHealth())
    } catch (err) {
      // The callable's errors are already sanitized server-side; this covers the case
      // where the call itself never lands.
      console.error('[marginalia] serverHealth failed', err)
      setError("Couldn't reach the server check.")
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Speech server</p>
        <Button variant="outline" size="sm" onClick={() => void check()} disabled={checking}>
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Check
        </Button>
      </div>

      {error ? <p className="text-destructive text-sm">{error}</p> : null}

      {health ? (
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge variant={health.ok ? 'default' : 'destructive'}>
              STT {health.ok ? 'up' : 'down'}
            </Badge>
            {/* Ollama fails independently of STT, so this is its own verdict. */}
            <Badge variant={health.llmOk ? 'secondary' : 'outline'}>
              LLM {health.llmOk ? 'up' : 'down'}
            </Badge>
          </div>

          <ModelList label="Transcription" ids={health.stt} />
          <ModelList label="Cleanup" ids={health.llm} />
        </div>
      ) : null}
    </div>
  )
}

function ModelList({ label, ids }: { label: string; ids: string[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted-foreground text-xs">{label}</p>
      {ids.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">none available</p>
      ) : (
        <ul className="flex flex-col">
          {ids.map((id) => (
            <li key={id} className="truncate font-mono text-xs">
              {id}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
