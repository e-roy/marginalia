import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Toaster } from '@/components/ui/sonner'
import { UpdateToast } from '@/components/UpdateToast'
import { Mark } from '@/components/Mark'
import { Now } from '@/routes/Now'
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

  return (
    <>
      <UpdateToast />
      <Toaster position="top-center" />
      {status === 'loading' ? (
        <Splash />
      ) : status === 'signed-out' ? (
        <SignIn />
      ) : (
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Now />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      )}
    </>
  )
}
