import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth'
import { create } from 'zustand'
import { auth } from '@/lib/firebase'

type AuthStatus = 'loading' | 'signed-in' | 'signed-out'

interface AuthState {
  user: User | null
  status: AuthStatus
  /** Sanitized message safe to render. Never contains upstream URLs. */
  error: string | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

/**
 * Popup everywhere, including the installed PWA.
 *
 * This used to branch on `isStandalone()` and use `signInWithRedirect` for the installed
 * app, on the assumption that an iOS PWA handles popups badly. The assumption was never
 * checked — the code carried a `TODO(M2): verify redirect actually completes on a real
 * installed iPhone PWA` — and when it finally was, on a real iPhone, redirect turned out
 * to be the broken path:
 *
 * `signInWithRedirect` bounces through `<authDomain>/__/auth/handler` and that handler
 * then has to hand the credential back to the app. The default `authDomain` is
 * `<project>.firebaseapp.com` while the app is served from `<project>.web.app`, so that
 * handoff is cross-origin — and Safari's tracking prevention blocks it.
 * `getRedirectResult()` came back empty, `onAuthStateChanged` fired null, and the user
 * landed back on the sign-in screen having apparently done nothing. **Nothing threw, and
 * no user was ever created**, so there was no error to find at any layer.
 *
 * It only broke the installed app: a browser tab took the popup branch, which hands the
 * credential back through the opener rather than a redirect, and worked fine throughout.
 *
 * The alternative fix is to point `authDomain` at the hosting domain so the handler is
 * same-origin — Firebase's documented advice — but that also requires authorizing
 * `https://<authDomain>/__/auth/handler` on the OAuth client, and popup needs neither.
 * If a future iOS blocks popups from standalone PWAs, `auth/popup-blocked` below is the
 * signal, and that is the moment to revisit this.
 */
export const useAuth = create<AuthState>((set) => ({
  user: null,
  status: 'loading',
  error: null,

  signIn: async () => {
    set({ error: null })
    const provider = new GoogleAuthProvider()
    try {
      await signInWithPopup(auth, provider)
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? String(err.code) : ''

      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return // user backed out; not an error worth showing
      }

      // The one failure that would send us back to the redirect flow. Named separately
      // so it is legible on a phone, where there is no console to read.
      if (code === 'auth/popup-blocked') {
        set({ error: 'The sign-in window was blocked. Try again.' })
        console.error('[marginalia] sign-in popup blocked', err)
        return
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
  onAuthStateChanged(auth, (user) => {
    useAuth.setState({
      user,
      status: user ? 'signed-in' : 'signed-out',
    })
  })
}
