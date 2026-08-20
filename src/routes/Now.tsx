import { LogOut } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'

import { BookBar } from '@/components/BookBar'
import { InstallCard } from '@/components/InstallCard'
import { Mark } from '@/components/Mark'
import { NoteList } from '@/components/NoteList'
import { RecordButton } from '@/components/RecordButton'
import { ServerCard } from '@/components/ServerCard'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useBook, useLiveNotes } from '@/hooks/useLibrary'
import { usingEmulators } from '@/lib/firebase'
import { isToday } from '@/lib/format'
import { ensurePlaceholderBook, PLACEHOLDER_BOOK_ID } from '@/lib/notes'
import { isRecordingSupported } from '@/lib/recorder'
import { useAuth } from '@/stores/auth'
import { initCapture, useCapture } from '@/stores/capture'

/**
 * The one screen that matters on a phone: current book, current chapter, big button.
 * Opens ready to record (SPEC §8).
 *
 * Milestone 2 is the pipeline, not the shelf — the recent-books strip, the real chapter
 * UI, and typed notes are Milestone 3.
 */
export function Now() {
  const user = useAuth((s) => s.user)
  const signOut = useAuth((s) => s.signOut)
  const uid = user?.uid ?? null

  const book = useBook(uid)
  const notes = useLiveNotes(uid)

  const status = useCapture((s) => s.status)
  const elapsedMs = useCapture((s) => s.elapsedMs)
  const queuedCount = useCapture((s) => s.queuedCount)
  const error = useCapture((s) => s.error)
  const lastAutoStop = useCapture((s) => s.lastAutoStop)
  const toggle = useCapture((s) => s.toggle)

  const supported = useMemo(() => isRecordingSupported(), [])
  const today = useMemo(() => notes.filter((note) => isToday(note.recordedAt)), [notes])

  useEffect(() => {
    if (!uid) return
    void ensurePlaceholderBook(uid)
    // Owns the queue-drain triggers for as long as someone is signed in.
    return initCapture(uid)
  }, [uid])

  useEffect(() => {
    if (!error) return
    toast.error(error)
    useCapture.setState({ error: null })
  }, [error])

  useEffect(() => {
    if (lastAutoStop === null) return
    toast.info(
      lastAutoStop === 'cap'
        ? 'Ten-minute limit reached — the note was saved.'
        : 'Recording stopped when the app went to the background. The note was saved.',
    )
    useCapture.setState({ lastAutoStop: null })
  }, [lastAutoStop])

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-5 py-6">
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
        <CardContent className="flex flex-col gap-5 pt-6">
          {uid ? <BookBar uid={uid} book={book} /> : null}

          {supported ? (
            <RecordButton
              status={status}
              elapsedMs={elapsedMs}
              disabled={!uid || !book}
              onToggle={() => {
                if (!uid || !book) return
                void toggle(uid, {
                  id: PLACEHOLDER_BOOK_ID,
                  title: book.title,
                  chapter: book.currentChapter,
                })
              }}
            />
          ) : (
            <p className="text-muted-foreground py-6 text-center text-sm">
              This browser can&rsquo;t record audio. Open Marginalia in Safari or Chrome.
            </p>
          )}

          {queuedCount > 0 ? (
            <p className="text-muted-foreground text-center text-xs">
              {queuedCount} recording{queuedCount === 1 ? '' : 's'} waiting to upload
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Today</CardTitle>
        </CardHeader>
        <CardContent>
          <NoteList notes={today} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <ServerCard />
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
