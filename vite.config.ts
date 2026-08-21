import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Iron-gall ink palette, carried over from the spec document.
const INK = '#1C2536'
const PAPER = '#EFEDE7'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // The firebase chunk sits just over Vite's 500 kB default warning. It is precached
    // once by the service worker and served from cache thereafter, so the size is a
    // one-time install cost rather than a per-visit one. Raised deliberately so the
    // warning stays meaningful if app code starts bloating.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Split the Firebase SDK out from app code. Total first-load bytes are the
        // same, but app changes then stop invalidating the largest precached chunk —
        // which matters when every update is re-downloaded over mobile data.
        // Rolldown (Vite 8) requires the function form here, not an object map.
        manualChunks(id: string) {
          if (/node_modules[\\/]@?firebase/.test(id)) return 'firebase'
          return undefined
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      // NOT 'autoUpdate'. 'prompt' leaves the new worker waiting instead of activating
      // itself, which is what lets `AutoUpdate` hold the reload back until nothing is
      // mid-recording. 'autoUpdate' would reload straight through a recording.
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Marginalia',
        short_name: 'Marginalia',
        description: 'Voice notes for the books you are reading.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: INK,
        background_color: PAPER,
        categories: ['books', 'productivity'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // The service worker caches the APP SHELL ONLY.
        // Firestore has its own IndexedDB persistence, and Storage uploads must never
        // be intercepted — caching either would corrupt sync. See CLAUDE.md.
        navigateFallbackDenylist: [/^\/__/],
        runtimeCaching: [],
      },
      devOptions: {
        // Keep the SW out of `pnpm dev`. Test install/offline with
        // `pnpm build && pnpm preview` instead.
        enabled: false,
      },
    }),
  ],
})
