# Marginalia

A phone-first PWA for capturing spoken notes about books, filed by book and chapter,
transcribed and cleaned by a self-hosted speech server.

**`SPEC.md` is the source of truth** for architecture, data model, and milestones. Read
the relevant section before implementing. Keep it updated when the design changes — it
and the code must not drift.

## Session memory

Session memory lives in an Obsidian vault at
`C:\Users\eric\Documents\Obsidian Vaults\marginalia`. Start sessions with
`/vault-sessions:start-session`, end with `/vault-sessions:wrap-session`.
Config: `.claude/session-workflow.md`.

Work **one milestone per session** (`SPEC.md §13`).

## The rule that matters most

**This repo is public. The speech server is a Mac Mini in a house.**

- `SPEECH_BASE_URL` and `SPEECH_API_KEY` are Secret Manager secrets, read only inside
  Cloud Functions via `defineSecret`. Never in source, never in a build artifact.
- **Never give either a `VITE_` prefix.** Vite inlines every `VITE_` variable into the
  client bundle at build time. The browser never talks to the speech server at all.
- Errors surfaced to the client are sanitized codes — `stt_unavailable`,
  `llm_unavailable`, `stt_timeout`. Never a raw fetch error containing the hostname.
- The Firebase *web* config (`apiKey`, `projectId`, …) is public by design and ships in
  every Firebase web app's bundle. It is fine behind `VITE_` and fine committed in
  `.env.example`. Don't confuse the two categories.

## Commands

```bash
pnpm dev          # Vite dev server
pnpm emu          # Firebase emulator suite (demo-marginalia)
pnpm typecheck    # tsc --noEmit
pnpm build        # typecheck + production build
pnpm preview      # serve the production build (use this to test the service worker)
pnpm lint
```

`pnpm typecheck`, `pnpm lint`, and `pnpm build` must all pass before wrapping a session.

## Stack and conventions

- **pnpm only.** Never `npm install` or `yarn` — it will corrupt the lockfile.
- **`minimumReleaseAge: 10080`** (7 days, in minutes) in `pnpm-workspace.yaml`, as
  supply-chain protection. A package newer than that will refuse to install. If one is
  genuinely needed, add it to `minimumReleaseAgeExclude` and note why.
- **Vite + React 19 + TypeScript**, strict mode.
- **Tailwind v4 + shadcn/ui.** Check the shadcn registry via the shadcn MCP before
  designing custom UI. Only hand-roll what the registry doesn't have.
- **zustand** for app-wide state. Component-local state stays local — don't reach for a
  store by default.
- **`vite-plugin-pwa`** for the manifest and service worker. It caches the app shell
  **only** — never Firestore traffic or Storage uploads. Firestore has its own IndexedDB
  persistence.

## Verifying work

**Use the chrome-devtools MCP to look at UI changes before claiming they work.** Take a
snapshot, read the console for errors, and check at an iPhone-sized viewport — iOS Safari
is the primary target, not desktop.

Service worker and install behaviour only appear in a production build: use
`pnpm build && pnpm preview`, not `pnpm dev`.

**Firebase emulators for everything local.** `pnpm emu` runs Auth, Firestore, Storage,
and Functions against project `demo-marginalia`. The `demo-` prefix makes the emulators
refuse to touch production, so there is no way to accidentally write to a real project.
Emulator state is ephemeral by default.

## Platform constraints worth remembering

iOS Safari has no Background Sync, no `BarcodeDetector`, produces `audio/mp4` rather than
`audio/webm` from `MediaRecorder`, stops recording when the PWA is backgrounded, and
evicts site data after ~7 days unless the app is installed to the Home Screen.

The speech server is not always up, only serves models listed in its `PRELOAD_MODELS`
(nothing downloads on demand), and its Ollama half fails independently of STT.

Full list in the vault at `Lessons/Lessons Learned.md` — check it before investigating
any of these afresh.
