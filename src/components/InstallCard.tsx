import { useState } from 'react'
import { Share, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { shouldPromptInstall } from '@/lib/platform'

const DISMISSED_KEY = 'marginalia:install-card-dismissed'

/**
 * iOS has no `beforeinstallprompt`, so installation has to be explained rather than
 * offered. This is not cosmetic: Safari evicts site data after ~7 days of non-use and
 * Home Screen apps are exempt, so an uninstalled user can lose queued recordings.
 */
export function InstallCard() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === 'true',
  )

  if (dismissed || !shouldPromptInstall()) return null

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, 'true')
    setDismissed(true)
  }

  return (
    <div className="bg-accent text-accent-foreground border-border relative rounded-lg border p-4 text-sm">
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 h-7 w-7"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </Button>
      <p className="pr-8 font-medium">Add Marginalia to your Home Screen</p>
      <p className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-1 pr-8">
        Tap
        <Share className="inline h-4 w-4" aria-label="the Share button" />
        then <span className="font-medium">Add to Home Screen</span>.
      </p>
      <p className="text-muted-foreground mt-2 pr-8 text-xs">
        Safari clears data for websites you haven&rsquo;t opened in a week. Installed
        apps are exempt — this is what keeps unsent recordings safe.
      </p>
    </div>
  )
}
