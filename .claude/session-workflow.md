# Session workflow config (read by the vault-sessions plugin)

<!-- Written by /vault-sessions:init — edit freely; the plugin commands read this file
     at the start of every run. -->

- **Vault:** `C:\Users\eric\Documents\Obsidian Vaults\marginalia`
- **Verify:** `pnpm typecheck`, `pnpm lint`, then `pnpm build` <!-- must pass before wrap -->
- **Commit policy:** wrap-only
- **Team mode:** solo
- **Optional vault sections:** Lessons

## Extra start steps

- Read `SPEC.md` §1 (decisions) and the section covering the milestone being worked.
  `SPEC.md` is the source of truth for architecture and data model; the vault tracks how
  the build is going.
- Check [[Lessons/Lessons Learned]] before investigating any iOS Safari, speech-server,
  Firebase, Vite, or pnpm behaviour — several constraints are already recorded there.
- Work **one milestone per session**. The roadmap's 🔨 Now item is the session's scope.

## Extra wrap steps

- If the session verified an iOS Safari or speech-server behaviour on a real device,
  update [[Lessons/Lessons Learned]] — several entries there are still marked
  "not yet verified on device" and should be corrected to what actually happened.
- If the session changed architecture or the data model, update **both**
  [[Project/Architecture]] and `SPEC.md`. They must not drift.
- Move the completed milestone from 🔨 Now to ✅ Done with the date, and promote the
  next milestone from 🔜 Next into 🔨 Now.

## Project reminders

- **pnpm only.** Never `npm install` or `yarn`. `minimumReleaseAge` is set to 7 days
  (10080 minutes) in `pnpm-workspace.yaml` as supply-chain protection — if a package
  genuinely needs a newer release, add it to `minimumReleaseAgeExclude` and say why.
- **Check the shadcn registry via MCP before designing custom UI.** Use shadcn/ui
  components with Tailwind v4; only hand-roll what the registry doesn't have.
- **Verify UI changes visually with the chrome-devtools MCP** — take a snapshot, check
  the console for errors, and test at mobile viewport (iPhone-sized) since that is the
  primary target. Do not claim a UI change works without looking at it.
- **Firebase emulators for everything local.** `pnpm emu` starts the suite against
  project `demo-marginalia`. The `demo-` prefix makes emulators refuse to touch
  production.
- **The repo is public.** The speech hostname and API key live only in Secret Manager.
  Never give either a `VITE_` prefix — Vite inlines those into the client bundle at build
  time. Client-facing errors are sanitized codes, never raw fetch errors.
- **zustand** for app-wide state. Local component state stays local.
