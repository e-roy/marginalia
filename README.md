# Marginalia

A phone-first PWA for capturing spoken notes about books, filed by book and chapter,
transcribed and cleaned up by a speech server you host yourself.

Pick up the phone mid-chapter, one tap, talk for thirty seconds, put the phone down.
Later that day, at a desk, read a clean punctuated paragraph filed under the right book
and the right chapter.

This is a personal, single-user app. It is public because there is no reason for it not
to be, not because it is a product.

## The problem it solves

Thoughts about a book arrive *while reading it*, and every way of capturing them is worse
than not capturing them. Typing breaks you out of the book. A voice memo app gives you an
undated blob you will never listen to. A notes app makes you decide where it goes before
you have finished having the thought.

So: one button, talk, done. The filing is a chapter number you set once and step forward
when you turn a page. The transcript catches up on its own.

## How it works

Five hops, and the phone is only present for the first one.

```
microphone → IndexedDB → Cloud Storage → transcribeNote → Firestore → the screen
```

1. **Record.** `MediaRecorder` writes a blob straight into IndexedDB, and the note
   document is created immediately. The UI is finished the moment you stop talking — lock
   the phone and walk away.
2. **Upload.** The queue drains to Cloud Storage whenever the app is open and online. iOS
   has no Background Sync, so "whenever the app is open" is the honest description.
3. **Transcribe.** Landing the object triggers a Cloud Function, which sends the audio to
   the speech server, writes the transcript back, and deletes the audio.
4. **Clean up.** The same function hands the verbatim transcript to a local LLM for light
   polish — punctuation, paragraphs, a short title. Best-effort by construction: a
   sleeping LLM cannot cost a note its transcript.
5. **Watch.** The phone is subscribed to the note document, so text appears when it
   appears. Nothing blocks on anything.

**Transcription is a job, not a request** — the design decision everything else follows
from. The speech server is a Mac Mini that sleeps, behind a tunnel that drops, and the app
gets used on mobile data in a chair away from home. A synchronous record-and-wait flow
would fail routinely. Instead a scheduled sweep retries stuck notes with backoff, and a
sleeping server is a non-event: the backlog drains when it wakes.

### The speech server

Transcription and cleanup run on [`e-roy/local-speech-server`](https://github.com/e-roy/local-speech-server)
— faster-whisper for speech-to-text and Ollama for the text cleanup, behind a tunnel. Its
address and key are Secret Manager secrets read only inside Cloud Functions. **The browser
never talks to it at all**, and errors surfaced to the UI are sanitized codes rather than
raw fetch failures, so a screenshot in a public issue cannot leak a home address.

### Audio is never kept

It is transient at every hop and deleted the moment a transcript commits. One deliberate
exception: a note that has exhausted its retries keeps its recording, so **Try again** has
something to act on when the server wakes up. A bucket lifecycle rule reclaims that after
about a day.

## Stack

React 19 · TypeScript · Vite · Tailwind v4 with shadcn/ui · zustand · `vite-plugin-pwa`
for the manifest and service worker. Firebase for auth, Firestore, Storage, Hosting, and
Cloud Functions (Node 22).

Google sign-in is required for everything, and it is the abuse control — it is the only
gate in front of somebody else's GPU.

The service worker caches the app shell, plus the barcode decoder once someone has
actually opened the scanner. It never touches Firestore traffic or Storage uploads;
Firestore brings its own IndexedDB persistence.

## Running it

pnpm only — `npm install` or `yarn` will corrupt the lockfile. Packages must also be at
least seven days old to install, as supply-chain protection.

```bash
pnpm install
```

```bash
pnpm dev
```

Everything local runs against the Firebase emulator suite, on project `demo-marginalia`.
The `demo-` prefix is what makes that safe: emulators refuse to touch a real project, so
there is no way to write to production by accident.

```bash
pnpm emu
```

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server |
| `pnpm emu` | Auth, Firestore, Storage and Functions emulators |
| `pnpm typecheck` | `tsc --noEmit` over the app **and** the functions package |
| `pnpm lint` | ESLint |
| `pnpm build` | typecheck, then a production build |
| `pnpm preview` | serve the production build — the only way to test the service worker |

Service worker and install behaviour do not exist in `pnpm dev`. Use `pnpm build && pnpm
preview` for anything involving them.

Standing up your own instance — a Firebase project on the Blaze plan, the Secret Manager
entries, a speech server of your own — is described in `SPEC.md` §2. You will need all
three; there is no hosted version to point at.

## Deploying

```bash
pnpm deploy:check
```

That is a dry run: it validates rules, builds everything, and deploys nothing. Then use
the narrow commands rather than a bare `firebase deploy`:

| Command | Scope |
|---|---|
| `pnpm deploy:web` | hosting only — the fast loop when testing on a phone |
| `pnpm deploy:fn` | functions only |
| `pnpm deploy:rules` | Firestore rules and indexes, Storage rules |
| `pnpm deploy:all` | all of the above |

The narrowness is not fastidiousness. `firebase deploy` releases hosting *after*
functions, so a function that fails to create takes the hosting release down with it — the
files upload, the log says the upload completed, and the site still serves "Site Not
Found". Deploying them separately keeps one failure from hiding the other.

(`deploy:all`, not `deploy` — `deploy` is a built-in pnpm command, and the collision makes
the bare form pass its own name through as an argument.)

## Where the truth lives

**`SPEC.md` is the source of truth** for architecture, the data model, and the milestones.
It is long, and it is meant to be — the decisions in it were settled before the code was
written, and code that drifts from it is the code that is wrong.

`CLAUDE.md` covers the same ground for an AI agent working in the repo: commands,
conventions, and the constraints that are expensive to rediscover.

## Status

Milestones 1 through 6 are done: the capture pipeline, books and chapters, the cleanup
pipeline, the barcode scanner, and the retry/resilience layer. Desktop reading, inline
editing, search and Markdown export are next.

What is proven on a real iPhone: installing to the Home Screen, Google sign-in in both
Safari and the installed app, the barcode scanner end to end, and a recording completing
the round trip to a transcript.

What is not: backgrounding mid-recording, and the seven-day storage-eviction exemption
that the whole offline queue depends on.

**One known bug:** transcripts come back missing their trailing sentences — one on a short
note, two on a longer one. The cleanup step is ruled out; it is either the recorder not
flushing its final chunk or the distilled Whisper model terminating early, and the
instrumentation to tell them apart is in place but has not yet been read.
