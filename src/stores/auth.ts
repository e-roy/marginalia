import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth'
import { create } from 'zustand'
import { auth } from '@/lib/firebase'
import { isStandalone } from '@/lib/platform'

type AuthStatus = 'loading' | 'signed-in' | 'signed-out'

interface AuthState {
  user: User | null
  status: AuthStatus
  /** Sanitized message safe to render. Never contains upstream URLs. */
  error: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  status: 'loading',
  error: null,

  signIn: async () => {
    set({ error: null })
    const provider = new GoogleAuthProvider()
    try {
      // An installed iOS PWA handles popups badly — the popup opens in Safari and
      // loses the standalone context. Redirect is the supported path there.
      // TODO(M2): verify redirect actually completes on a real installed iPhone PWA.
      if (isStandalone()) {
        await signInWithRedirect(auth, provider)
      } else {
        await signInWithPopup(auth, provider)
      }
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? String(err.code) : ''
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return // user backed out; not an error worth showing
      }
      set({ error: "Couldn't sign in. Check your connection and try again." })
      console.error('[marginalia] sign-in failed', err)
    }
  },

  signOut: async () => {
    await fbSignOut(auth)
  },
}))

/** Called once from main.tsx. Owns the auth subscription for the app's lifetime. */
export function initAuth() {
  // Completes a redirect sign-in that started before the page reloaded.
  void getRedirectResult(auth).catch((err: unknown) => {
    useAuth.setState({ error: "Couldn't finish signing in. Try again." })
    console.error('[marginalia] redirect result failed', err)
  })

  onAuthStateChanged(auth, (user) => {
    useAuth.setState({
      user,
      status: user ? 'signed-in' : 'signed-out',
    })
  })
}
