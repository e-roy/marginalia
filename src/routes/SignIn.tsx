import { Button } from '@/components/ui/button'
import { InstallCard } from '@/components/InstallCard'
import { Mark } from '@/components/Mark'
import { useAuth } from '@/stores/auth'

export function SignIn() {
  const signIn = useAuth((s) => s.signIn)
  const error = useAuth((s) => s.error)

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 py-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <Mark className="h-20 w-20" />
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">Marginalia</h1>
            <p className="text-muted-foreground text-balance">
              Voice notes for the books you&rsquo;re reading, filed by chapter.
            </p>
          </div>
        </div>

        <div className="w-full space-y-3">
          <Button className="h-12 w-full text-base" onClick={() => void signIn()}>
            Continue with Google
          </Button>
          {error ? (
            <p className="text-destructive text-center text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <InstallCard />
      </div>
    </main>
  )
}
