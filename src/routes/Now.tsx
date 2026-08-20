import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { InstallCard } from '@/components/InstallCard'
import { Mark } from '@/components/Mark'
import { usingEmulators } from '@/lib/firebase'
import { useAuth } from '@/stores/auth'

/**
 * The signed-in shell. Milestone 1 stops here deliberately — the record button and
 * everything behind it land in Milestone 2, built end to end on a real phone before
 * any UI worth keeping gets written.
 */
export function Now() {
  const user = useAuth((s) => s.user)
  const signOut = useAuth((s) => s.signOut)

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-5 py-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Mark className="h-9 w-9 shrink-0" />
          <div className="min-w-0">
            <p className="leading-tight font-semibold">Marginalia</p>
            <p className="text-muted-foreground truncate text-xs">
              {user?.email ?? user?.displayName ?? 'Signed in'}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void signOut()}
          aria-label="Sign out"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </header>

      <InstallCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Milestone 1 complete</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-3 text-sm">
          <p>
            The shell installs, signs in, and holds state. Nothing captures audio yet —
            that&rsquo;s Milestone 2.
          </p>
          <p>
            Next up: <span className="text-foreground font-medium">capture to
            transcript</span> — MediaRecorder, the IndexedDB queue, Storage upload, and
            the <code className="text-xs">transcribeNote</code> function, end to end on
            a real iPhone.
          </p>
        </CardContent>
      </Card>

      {usingEmulators ? (
        <p className="text-muted-foreground mt-auto text-center text-xs">
          Running against Firebase emulators ·{' '}
          <code className="text-xs">demo-marginalia</code>
        </p>
      ) : null}
    </div>
  )
}
