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
import { useAuth } from '@/stores/auth'

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Mark className="h-14 w-14 animate-pulse" />
      <span className="sr-only">Loading</span>
    </div>
  )
}

export default function App() {
  const status = useAuth((s) => s.status)
  const signingIn = useAuth((s) => s.signingIn)

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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      )}
    </>
  )
}
