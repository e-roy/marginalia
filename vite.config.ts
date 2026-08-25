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
          // The barcode decoder, given a stable chunk name so the two service-worker
          // rules below have something to match on. Only the lazy `Scan` route imports
          // it, so naming the chunk does not pull it into the initial load.
          if (/node_modules[\\/]@zxing/.test(id)) return 'zxing'
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
        // `globPatterns` sweeps in EVERY emitted .js, which would precache the barcode
        // decoder for everyone — a large addition to a precache already carrying the
        // app bundle, the firebase chunk, fonts and icons, re-downloaded on every
        // deploy that rehashes it, for a feature most launches never touch. The
        // pattern resolves against the build output root, so the `assets/` prefix is
        // required; without it this silently matches nothing and the build still
        // succeeds.
        globIgnores: ['assets/zxing-*.js'],
        // The service worker caches the APP SHELL, plus the scanner chunk once it has
        // actually been fetched (below).
        // Firestore has its own IndexedDB persistence, and Storage uploads must never
        // be intercepted — caching either would corrupt sync. See CLAUDE.md.
        navigateFallbackDenylist: [/^\/__/],
        runtimeCaching: [
          {
            // The other half of the globIgnores above: excluded from the precache, but
            // kept once someone actually opens the scanner, so the second scan works
            // offline. This is our own application JavaScript with a content hash in
            // its name — not Firestore or Storage traffic, which stay off limits.
            urlPattern: /\/assets\/zxing-[^/]*\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'zxing-decoder',
              // The hash only moves when the dependency does; two entries is enough to
              // cover an update without accumulating superseded copies forever.
              expiration: { maxEntries: 2 },
            },
          },
          {
            /**
             * Book covers, which without this are **slow every single time**.
             *
             * `covers.openlibrary.org` answers with `Cache-Control: public` and **no
             * `max-age`**, and no `Last-Modified` either — only an ETag. With no freshness
             * lifetime the browser has nothing to compute staleness from, so it revalidates
             * against the network before painting. That round trip is the delay, and on a
             * slow or absent connection it is why a cover sometimes never appears at all.
             * `CacheFirst` skips the revalidation entirely.
             *
             * Cached as **real** responses rather than opaque ones: covers send
             * `Access-Control-Allow-Origin: *`, so there is no opaque-response quota
             * penalty and the entries can be counted and bounded.
             *
             * This is third-party *image* traffic — it is neither Firestore sync nor a
             * Storage upload, which is the line CLAUDE.md and the rule above actually draw.
             * The alternatives were both worse: base64 in the book document would put
             * ~25 kB on every book in a collection `useBooks` subscribes to whole, and
             * Firebase Storage would be silently reclaimed by `storage.lifecycle.json`,
             * which deletes everything under `users/` at one day old.
             */
            urlPattern: /^https:\/\/covers\.openlibrary\.org\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'book-covers',
              // Comfortably more books than a reader has, and ~19 kB each at `-M`. A year,
              // because a cover for a given id is immutable — the id changes, not the image.
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 365 },
              // A cover that 404s must not be cached as though it were the artwork.
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Keep the SW out of `pnpm dev`. Test install/offline with
        // `pnpm build && pnpm preview` instead.
        enabled: false,
      },
    }),
  ],
})
