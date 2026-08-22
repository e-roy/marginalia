import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { AutoUpdate } from '@/components/AutoUpdate'
import { Mark } from '@/components/Mark'
import { Book } from '@/routes/Book'
import { Books } from '@/routes/Books'
import { Note } from '@/routes/Note'
import { Now } from '@/routes/Now'
import { Settings } from '@/routes/Settings'
import { SignIn } from '@/routes/SignIn'
import { initKeyboardInset } from '@/lib/keyboard'
import { useAuth } from '@/stores/auth'

/**
 * The only lazy route in the app, and the reason `Suspense` is here at all. The barcode
 * decoder is the largest dependency in the bundle and `SPEC §9` requires it never reach
 * the capture path — so it loads when someone opens the scanner and not before. See
 * `vite.config.ts` for the matching chunk name and service-worker rules.
 */
const Scan = lazy(() => import('@/routes/Scan').then((m) => ({ default: m.Scan })))

function Splash() {
  return (
    <div className="flex min-h-[var(--app-height)] items-center justify-center">
      <Mark className="h-14 w-14 animate-pulse" />
      <span className="sr-only">Loading</span>
    </div>
  )
}

export default function App() {
  const status = useAuth((s) => s.status)
  const signingIn = useAuth((s) => s.signingIn)

  // Tracks the software keyboard for as long as the app is open, so bottom sheets can
  // sit above it. Here rather than in a sheet, because it is one subscription for the
  // whole app and both sheets read the same custom property.
  useEffect(() => initKeyboardInset(), [])

  // `signingIn` covers the gap between the sign-in popup closing and Firebase reporting
  // a session. Without it the sign-in screen reappears for that moment, which looks like
  // the sign-in bounced rather than worked.
  const pending = status === 'loading' || signingIn

  return (
    <>
      <AutoUpdate />
      <Toaster position="top-center" />
      {pending ? (
        <Splash />
      ) : status === 'signed-out' ? (
        <SignIn />
      ) : (
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Now />} />
            <Route path="/books" element={<Books />} />
            <Route path="/books/:bookId" element={<Book />} />
            <Route path="/notes/:noteId" element={<Note />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="/scan"
              element={
                <Suspense fallback={<Splash />}>
                  <Scan />
                </Suspense>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      )}
    </>
  )
}
