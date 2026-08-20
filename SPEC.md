# Marginalia — Voice Notes for Books

A phone-first PWA for capturing spoken notes about books, filed by book and
chapter, transcribed and cleaned by a self-hosted speech server, and read back
on a desktop.

**Status:** spec / not yet implemented
**Repo:** public — see §2 before writing any config
**Primary target:** iPhone, installed to the Home Screen
**Stack:** Vite + React + TypeScript PWA · Firebase (Auth, Firestore, Storage, Functions, Hosting)
**Speech:** [`e-roy/local-speech-server`](https://github.com/e-roy/local-speech-server) — faster-whisper STT + Ollama LLM, behind a Cloudflare Tunnel

---

## 1. Decisions locked

| Decision | Choice |
|---|---|
| Repo visibility | Public. No server hostname, no keys, no project identifiers in source. |
| Auth | Google sign-in, required for everything. This is the abuse control. |
| Frontend | Vite + React + TypeScript, static SPA on Firebase Hosting |
| Firebase plan | Blaze (required — Functions cannot reach non-Google hosts on Spark) |
| Primary device | iPhone / Safari. Android stays functional but is not the design target. |
| Capture kinds | Voice note and typed note. No photos, no quote/passage type. |
| Chapters | Auto-numbered. Titles optional, addable later. No dialog while reading. |
| Multi-book | Recent-books strip on home; each book remembers its own chapter. |
| Adding books | ISBN barcode scan, Open Library search, or manual entry |
| Models | Discovered at runtime from the server. Never hardcoded. |
| Cleanup | Deterministic filler strip, then a light LLM polish. Raw always retained. |
| Reading back | Same app with a desktop layout, plus per-book Markdown export |
| Audio retention | None. Transient at every hop, deleted the moment a transcript commits. |
| App Check | Deferred — Google sign-in already gates every path. |

---

## 2. Configuration and secrets

The repo is public. That is a design constraint, not a deployment detail, and it
decides where several things live.

### What never enters the repo

| Value | Where it lives | Why |
|---|---|---|
| Speech server hostname | Secret Manager → `SPEECH_BASE_URL` | Not a credential, but it's the address of a machine in your house. |
| Speech API key | Secret Manager → `SPEECH_API_KEY` | Grants GPU access. |
| Firebase project ID | `.firebaserc`, gitignored | Commit `.firebaserc.example`; select locally with `firebase use --add`. |

Both secrets are injected with `defineSecret(...)` and read only inside the
function. Neither is a build-time value, so neither can be inlined anywhere.

### The `VITE_` footgun

Vite **inlines every `VITE_`-prefixed variable into the client bundle at build
time**. Anything with that prefix is public by definition, whether the repo is
or not.

> The speech hostname must never carry a `VITE_` prefix. It is not a frontend
> value at all — the browser never talks to the speech server.

### What is safe to commit, and is not worth hiding

The Firebase **web config** — `apiKey`, `authDomain`, `projectId`,
`storageBucket`, `appId` — is a set of public identifiers. It ships in the
JavaScript bundle of every Firebase web app and cannot be hidden. Security comes
from Firestore and Storage rules plus a restricted OAuth consent screen, not
from concealing these.

Still put them in `.env` behind `VITE_` and commit a `.env.example`, so anyone
forking the repo supplies their own project rather than pointing at yours.

Also safe and worth committing: `firebase.json`, `firestore.rules`,
`storage.rules`, `firestore.indexes.json`.

### Redact upstream URLs from client-facing errors

Cloud Logging is private, so logging the full URL server-side is fine. But an
error surfaced into the UI can end up in a screenshot in a public issue. Any
error written to `note.error.message` must be a sanitized code —
`stt_unavailable`, `llm_unavailable`, `stt_timeout` — never a raw fetch error
containing the hostname.

### Irreversible at project creation

**A Firestore database's location is permanent.** Changing it later means a new
project and a data migration. Pick the region deliberately and put Cloud
Functions in the matching region — `nam5` multi-region with `us-central1`
functions is the sane US default. The Storage bucket should match too, or every
audio read pays cross-region egress.

### Setup order

1. Firebase project, Blaze billing attached
2. Firestore in the chosen location; Storage bucket in the matching region
3. Auth → Google provider; restrict the OAuth consent screen to internal/testing
   so only your account can complete a sign-in
4. `firebase functions:secrets:set SPEECH_BASE_URL` and `SPEECH_API_KEY`
5. Storage lifecycle rule: delete `users/*/uploads/**` older than 1 day
6. `firebase init` — hosting, firestore, storage, functions (TypeScript)
7. `.firebaserc` into `.gitignore` before the first commit

---

## 3. The constraints that shape everything

The speech server is a Mac Mini in a house, behind a Cloudflare Tunnel, and the
client is an iPhone. Three consequences drive the architecture.

**The API key can never reach the browser.** The server's own docs say so. A
static SPA cannot hold a bearer token that grants GPU access. Every call to the
speech server goes through a Cloud Function holding the key in Secret Manager.
Side effect: the app's origin never needs to be in the server's
`ALLOWED_ORIGINS` allowlist, because all traffic is server-to-server — so the
public repo never has to document your domain either.

**The server is not always up.** The Mac Mini sleeps, the tunnel drops, Ollama
can be down independently of STT (HTTP 502, `upstream_unavailable`). The app is
used away from home, on mobile data, sometimes with no signal. A synchronous
record-wait-transcript flow would fail routinely.

**iOS has no Background Sync.** Whatever the phone still holds when the app
closes stays held until the app reopens. So the device-dependent window has to
be as small as possible.

Together these mean transcription is an **asynchronous job, not a request**, and
the phone's only job is to get bytes into Storage.

---

## 4. Architecture

```
 iPhone (PWA)                Firebase                      Mac Mini
┌──────────────┐      ┌───────────────────────┐      ┌──────────────────┐
│ MediaRecorder│      │                       │      │                  │
│      ↓       │      │  Storage              │      │  Caddy (auth)    │
│  IndexedDB   │─────▶│  users/{uid}/uploads/ │      │        ↓         │
│ (holds audio │ up   │        │              │      │  Speaches / STT  │
│  until sent) │ load │        ▼ onObjectFin.  │      │  faster-whisper  │
│              │      │  transcribeNote ──────┼─────▶│  /v1/audio/      │
│  Firestore   │      │        │              │ TLS  │   transcriptions │
│  onSnapshot  │◀─────│        ▼              │◀─────│                  │
│  (live UI)   │      │  Firestore            │      │  Ollama          │
└──────────────┘      │  users/{uid}/notes    │      │  /v1/llm/chat/   │
                      │        │              │      │    completions   │
                      │        ▼ delete audio │      └──────────────────┘
                      │  retrySweep (5 min)   │
                      └───────────────────────┘
```

**Flow**

1. **Record.** `MediaRecorder` produces a blob. It goes straight into IndexedDB
   and a note document is created with `status: 'queued'`. The UI is finished at
   this point — lock the phone and walk away.
2. **Upload.** A resumable Storage upload sends the blob to
   `users/{uid}/uploads/{noteId}`. On success the local blob is deleted and the
   note moves to `pending`.
3. **Transcribe.** `onObjectFinalized` fires `transcribeNote`. It reads the
   object, POSTs multipart to the speech server, runs the cleanup pipeline,
   writes the text back, and **deletes the Storage object**.
4. **Display.** The phone is subscribed via `onSnapshot`, so notes fill in live.
   If the app was closed, the note is simply complete next time it opens.
5. **Retry.** `retrySweep` runs every 5 minutes, picks up notes in `pending` or
   `failed` with `attempts < 6`, and re-runs step 3 with exponential backoff.
   When the Mac Mini wakes, the backlog drains itself.

### Where iOS actually bites

Only step 2 depends on the device staying awake, and step 2 needs **internet,
not the Mac Mini** — so it normally completes in seconds. Once bytes are in
Storage, the cloud owns the job and the phone is irrelevant.

Because there is no Background Sync, the queue is flushed on every plausible
trigger instead:

- app launch
- `visibilitychange` → visible
- `online` event
- after each successful upload, immediately attempt the next

Any note still queued is shown with an explicit
`Waiting to upload — open the app on Wi-Fi` state. The user is never left
guessing why a note is blank.

---

## 5. Model discovery

No model name is hardcoded anywhere. Two reasons, and the second is the one that
would actually bite:

1. The hostname and setup are private; the repo should carry no assumptions
   about what's installed.
2. **`PRELOAD_MODELS` gates what is loadable.** Per `docs/operations.md`, only
   listed models can be used and *nothing downloads at request time*. A
   hardcoded model that isn't preloaded is a guaranteed 4xx, not a slow path.

### `serverHealth` — callable, auth-required

Fans out to both discovery endpoints, which the Caddyfile confirms are routed:

```
GET /v1/models       → speaches   (STT models, read-only for consumers)
GET /v1/llm/models   → Ollama     (pulled models, via the /v1/llm/* catch-all)
```

```ts
interface ServerHealth {
  ok: boolean;                 // STT reachable
  llmOk: boolean;              // false if Ollama 502s — it fails independently
  stt: string[];               // model ids
  llm: string[];               // model ids
  checkedAt: string;
}
```

Called from Settings, and once on the first transcription of a cold start.

### Auto-pick when nothing is chosen

- **STT:** first id matching `/whisper/i`, explicitly excluding `/kokoro/i` —
  the TTS model is preloaded alongside the STT models and will appear in the
  same list.
- **LLM:** first available id. If the list is empty or `llmOk` is false, skip
  Stage 3 entirely and keep Stage 2 output.

Settings lets you override both, and pin a choice once you know what you like.

---

## 6. Data model (Firestore)

Everything nests under `users/{uid}`.

### `users/{uid}/settings/app`

A single document, so the function can read it in one get.

```ts
interface Settings {
  sttModel: string | null;   // null = auto-pick
  llmModel: string | null;   // null = auto-pick, 'none' = disable polish
  lastHealth: ServerHealth | null;
}
```

### `users/{uid}/books/{bookId}`

```ts
interface Book {
  title: string;
  authors: string[];
  coverUrl: string | null;        // covers.openlibrary.org
  openLibraryKey: string | null;  // e.g. "/works/OL45804W"
  isbn13: string | null;          // from the barcode scan
  status: 'reading' | 'finished' | 'shelved';

  // Chapter numbers ARE the identity. No chapter IDs anywhere.
  // Titles are optional and resolved at render time from this map.
  chapterTitles: Record<string, string>;  // { "12": "The Science of Availability" }
  currentChapter: number | null;          // per-book resume point; null = Unfiled

  noteCount: number;
  lastNoteAt: Timestamp | null;   // drives the recent-books strip
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

Auto-numbering pays off here. With numbers as identity there are no chapter
documents, no ID reconciliation, no denormalized chapter title to drift out of
sync, and renumbering is a single map rewrite. A chapter "exists" the moment a
note references it.

### `users/{uid}/notes/{noteId}`

Top-level under the user, not nested under the book, so the home feed and search
stay single queries.

```ts
type NoteStatus =
  | 'queued'        // audio in IndexedDB, not yet uploaded
  | 'pending'       // uploaded, waiting on the speech server
  | 'transcribing'  // function is working
  | 'done'
  | 'failed';       // gave up after max attempts

interface Note {
  source: 'voice' | 'text';

  bookId: string;
  bookTitle: string;          // denormalized for the feed
  chapter: number | null;     // null = Unfiled

  status: NoteStatus;         // text notes are born 'done'
  rawText: string | null;     // verbatim Whisper output, never overwritten
  cleanText: string | null;   // after filler strip + polish
  title: string | null;       // LLM-suggested, 5-8 words
  edited: boolean;            // once hand-edited, re-polish won't overwrite

  durationMs: number | null;  // null for text notes
  recordedAt: Timestamp;      // client clock at record time — the real one
  transcribedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;

  sttModel: string | null;    // what was actually used, recorded after the fact
  llmModel: string | null;    // null if polish was skipped or rejected

  audioPath: string | null;   // nulled when the object is deleted
  attempts: number;
  nextAttemptAt: Timestamp | null;
  error: { code: string; message: string } | null;  // sanitized — see §2

  tags: string[];
  page: number | null;
  pinned: boolean;
}
```

A typed note sets `source: 'text'`, writes the same string to `rawText` and
`cleanText`, and goes straight to `done`. It never touches Storage, the
function, or the pipeline. If you typed it, you meant it.

**Composite indexes**

- `notes`: `bookId ASC, chapter ASC, recordedAt ASC` — book detail
- `notes`: `status ASC, nextAttemptAt ASC` — retry sweep
- `notes`: `recordedAt DESC` — home feed
- `books`: `lastNoteAt DESC` — recent-books strip

---

## 7. The cleanup pipeline

Three stages inside `transcribeNote`, for voice notes only. Each later stage may
fail without losing the note.

### Stage 1 — Transcribe, with context

`POST /v1/audio/transcriptions`, multipart:

| Field | Value |
|---|---|
| `file` | the audio blob, filename extension matching the real container |
| `model` | from settings, or auto-picked per §5 |
| `response_format` | `json` |
| `temperature` | `0` |
| `prompt` | book context — see below |

The `prompt` field is the highest-leverage detail in this document. Whisper
accepts an initial prompt that biases decoding, so feed it the book:

```
Notes on "Thinking, Fast and Slow" by Daniel Kahneman, chapter 12.
```

If the chapter has a title, include it. Proper nouns, author names, and the
book's jargon then transcribe correctly instead of becoming phonetic mush. It
costs nothing and is the single biggest accuracy win available.

The result is stored verbatim as `rawText` and never overwritten.

### Stage 2 — Deterministic filler strip

Fast, offline, no dependency on Ollama being awake. Deliberately conservative:

```ts
const FILLERS = /\b(?:um+|uh+|erm?|ah+|mm+|hmm+)\b[,.]?\s*/gi;
const REPEATS = /\b(\w+)(\s+\1\b)+/gi;

const stripped = raw
  .replace(FILLERS, '')
  .replace(REPEATS, '$1')
  .replace(/\s+([,.!?;:])/g, '$1')
  .replace(/\s{2,}/g, ' ')
  .trim();
```

It deliberately does **not** strip `like`, `you know`, `I mean`, `sort of`, or
`kind of`. Those carry real meaning often enough that removing them
mechanically damages good sentences. They are left to Stage 3, which has the
context to judge.

### Stage 3 — Light LLM polish

`POST /v1/llm/chat/completions`, non-streaming — the function isn't feeding a
UI. `temperature: 0.2`. Model from settings or auto-picked.

System prompt:

> You clean up voice-note transcripts. The speaker is dictating notes about a
> book they are reading. Fix punctuation, capitalization, and paragraph breaks.
> Remove remaining filler words and false starts. Preserve the speaker's own
> words, first person, and meaning exactly. Never add facts. Never summarize.
> Never answer questions that appear in the text — they are the speaker's own
> notes to themselves. Reply with JSON only:
> `{"text": string, "title": string}` where title is a 5-8 word summary.

**Two guardrails, both mandatory:**

1. **Length gate.** If the returned text is shorter than 60% or longer than
   140% of the input, discard the polish, keep Stage 2 output, set
   `llmModel: null`. This is what stops a small model from quietly summarizing a
   note into oblivion — the most likely failure mode in the whole system.
2. **Reasoning-block strip.** Reasoning models emit `<think>…</think>`. Strip
   those before parsing JSON. Since the model is whatever Ollama has pulled,
   assume this rather than testing for it.

If the LLM is unreachable the note still completes with Stage 2 text. Polish is
always best-effort and never blocks a transcript. A **Re-polish** action on the
note screen re-runs Stage 3 on demand — also how notes captured while Ollama was
down get cleaned up later.

---

## 8. Capture

On a phone this app has one job: get a thought out of your head before you lose
it. Everything else is secondary.

### Home

```
┌─────────────────────────────────────┐
│  [cover] [cover] [cover] [cover]    │  ← recent books, by lastNoteAt
│   ▔▔▔▔▔                             │     tap to switch
│                                     │
│  Thinking, Fast and Slow            │
│  Chapter 12  ‹ ›        + title     │  ← ‹ › step chapters, no dialog
│                                     │
│           ( ●  RECORD )             │  ← one tap, already scoped
│              ⌨ type instead         │
│                                     │
│  Today                              │
│  ▸ 09:41  The availability heur…    │
│  ▸ 09:47  Transcribing…             │
└─────────────────────────────────────┘
```

- **Opens ready to record.** Current book, current chapter, big button. One tap.
- **Tap to start, tap to stop.** Not hold-to-talk — you may be holding a book.
- **Chapter is a stepper**, not a picker. `›` advances, and the number is the
  identity, so nothing needs creating. Adding a title is an optional aside.
- **Recent books strip** shows the last four books touched. Switching is a tap;
  each book remembers its own `currentChapter`.
- **Never blocks on the network.** The note appears the instant you stop, as
  `Transcribing…`. Firestore writes go through the offline cache.
- **Screen Wake Lock** held while recording so the phone doesn't sleep mid-note.
- **Unfiled always available** for front-matter or whole-book thoughts.
- **Ten-minute cap** with a visible timer, for the reason in §12.

### Screens

| Screen | Purpose |
|---|---|
| Now | Recent books, chapter stepper, record + type, today's notes |
| Books | Shelf grouped by reading / finished / shelved; add book |
| Book | Chapters with note counts; notes grouped by chapter; add titles |
| Note | Clean text (editable), raw toggle, re-polish, move chapter, delete |
| Scan | Camera barcode scanner (lazy route) |
| Search | Client-side across all notes |
| Settings | Server health, model pickers, export, sign out |

Search is client-side on purpose. Firestore has no full-text search, a single
reader's lifetime of notes is a few megabytes, and Firestore persistence has
already cached them. Algolia would be cost and complexity for nothing.

---

## 9. Adding a book

Three paths into the same form. All of them end editable, because metadata is
frequently wrong and you should never be stuck.

### ISBN barcode scan

Lazy-loaded route — the decoder is ~200KB and must never touch the capture
bundle.

**Decoder.** iOS Safari has no `BarcodeDetector` API, so
[`@zxing/browser`](https://github.com/zxing-js/browser) is the primary path.
Use the native detector only where it exists:

```ts
const detector = 'BarcodeDetector' in window
  ? new BarcodeDetector({ formats: ['ean_13'] })
  : await loadZxing();   // dynamic import
```

**Camera.** `getUserMedia({ video: { facingMode: 'environment' } })`. HTTPS
required, which Firebase Hosting gives. Works in an installed iOS PWA.

**Validate before looking up.** Book barcodes are EAN-13 starting `978` or
`979`. Check the ISBN-13 checksum and reject anything else — misreads are common
and a bad lookup wastes a round trip and confuses the user.

**Lookup.** One call, returns title, authors, and cover:

```
https://openlibrary.org/api/books?bibkeys=ISBN:{isbn13}&format=json&jscmd=data
```

Not found is normal, not an error. Prefill the ISBN, let the user type the rest.

### Open Library search

```
https://openlibrary.org/search.json?q={q}&fields=key,title,author_name,cover_i,first_publish_year&limit=8
```

CORS-enabled, no API key, called directly from the browser. Debounce 300ms.
Cover art: `https://covers.openlibrary.org/b/id/{cover_i}-M.jpg`.

### Manual

Title and author, nothing else required. Always available, always the fallback.

---

## 10. Auth and security

Google sign-in, required everywhere. Restrict the OAuth consent screen to
internal/testing so only your account can complete a sign-in.

**The attack surface is genuinely small.** `transcribeNote` is a Storage trigger
and `retrySweep` is a scheduler job — neither has an HTTP endpoint at all. The
only callable functions are `repolishNote` and `serverHealth`, both of which
check `request.auth` and reject anonymous callers. There is no unauthenticated
path to the Mac Mini.

**Firestore rules**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

**Storage rules** — the client can write audio but never read it back. Only the
function, via the Admin SDK, reads the object.

```
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/uploads/{noteId} {
      allow write: if request.auth != null
                   && request.auth.uid == uid
                   && request.resource.size < 25 * 1024 * 1024
                   && request.resource.contentType.matches('audio/.*');
      allow read, delete: if false;
    }
  }
}
```

**Backstops**

- A bucket lifecycle rule deletes anything under `uploads/` older than one day,
  so a crashed function can never leave audio lying around. Given that audio is
  never meant to be kept, this is what makes it true rather than merely intended.
- Both secrets live only in Secret Manager. Never in the bundle, never in a
  shipped `.env`, never in Firestore, never in a client-facing error string.
- **App Check is deferred.** With sign-in required on every path and no
  unauthenticated HTTP surface, it adds defense in depth rather than closing an
  open hole. Add it if the app ever grows a public endpoint.

---

## 11. Export

Per-book Markdown, generated client-side, with YAML frontmatter so it drops
straight into Obsidian. Untitled chapters export as just the number.

```markdown
---
title: "Thinking, Fast and Slow"
author: "Daniel Kahneman"
isbn: "9780374533557"
tags: [book-notes]
exported: 2026-08-19
---

# Thinking, Fast and Slow

## Chapter 12 — The Science of Availability

**2026-08-14 · 09:41**

The availability heuristic explains why I keep overestimating how common plane
crashes are. Worth connecting this to the news-diet argument from earlier.
```

"Export all" produces a zip with one file per book. It runs entirely in the
browser from already-cached Firestore data — no function, no cost.

---

## 12. iPhone notes

The primary target is Safari on iOS, installed to the Home Screen. These are the
things that will actually cost a day.

**Safari's `MediaRecorder` does not produce webm.** It gives `audio/mp4` (AAC).
Feature-detect and send a matching filename extension, because Whisper sniffs
the container:

```ts
const CANDIDATES = [
  { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a'  }, // Safari / iOS — primary
  { mime: 'audio/webm;codecs=opus',     ext: 'webm' }, // Chrome, Firefox
  { mime: 'audio/mp4',                  ext: 'm4a'  },
];
const pick = CANDIDATES.find(c => MediaRecorder.isTypeSupported(c.mime));
```

Set `audioBitsPerSecond: 32000` — ample for speech (Whisper resamples to 16kHz
mono anyway) and it keeps a ten-minute note near 2.4 MB.

**Recording stops when the PWA is backgrounded.** Handle `visibilitychange` by
stopping cleanly and keeping the partial note rather than losing it. Another
reason notes are short by design.

**Installing to the Home Screen matters for more than feel.** Safari evicts site
data after roughly seven days of non-use, and Home Screen apps are exempt. The
IndexedDB upload queue depends on that. There is no `beforeinstallprompt` on
iOS, so ship a first-run card explaining Share → Add to Home Screen, and detect
`display-mode: standalone` to stop showing it.

**No Background Sync.** Covered in §4 — the queue drains on launch, visibility,
and `online`.

**Wake Lock and getUserMedia both work** in an installed iOS PWA on current iOS.
Acquire the wake lock only while recording and release it immediately after.

**Cloudflare cuts responses at roughly 100 seconds.** A distil-whisper model on
Apple Silicon runs well above realtime, so a ten-minute note transcribes in
about a minute — comfortable, not unlimited. Hence the ten-minute cap. If longer
notes are ever needed, split the audio at silence boundaries in the function and
concatenate transcripts.

**Keep the service worker away from Firestore.** Workbox caches the app shell
only. Firestore has its own IndexedDB persistence (`persistentLocalCache` with
`persistentMultipleTabManager`). Never cache Firestore traffic or Storage
uploads in the service worker.

---

## 13. Milestones

1. **Scaffold** — Vite + React + TS, `vite-plugin-pwa`, Firebase project, Google
   sign-in, `.gitignore` and `.env.example` correct from the first commit, an
   installable shell that signs in and does nothing else. Verify it installs to
   the Home Screen on the actual phone.
2. **Capture to transcript** — MediaRecorder, IndexedDB queue, Storage upload,
   `transcribeNote`, `serverHealth` discovery, live note via `onSnapshot`.
   Stage 1 only.
3. **Books and chapters** — Open Library search, shelf, chapter stepper, recent
   books strip, the one-tap home screen. Typed notes land here too — they're
   nearly free once the note model exists.
4. **Cleanup pipeline** — Stages 2 and 3, length gate, raw/clean toggle,
   re-polish action, model pickers in Settings.
5. **Barcode scan** — lazy scanner route, ZXing, ISBN-13 validation, Open
   Library lookup.
6. **Resilience** — `retrySweep`, backoff, queue UI, server-health indicator,
   failed-note recovery.
7. **Desktop and export** — wide reading layout, inline editing, client-side
   search, Markdown export.
8. **Polish** — tags, page numbers, pinning, desktop keyboard shortcuts.

Milestone 2 is the risk. Build it first, end to end, on the real iPhone, before
writing any UI worth keeping. Everything uncertain here — m4a handling, tunnel
latency, the async job model, Home Screen storage durability — is settled or
exposed by that one milestone.

---

## 14. Deferred

- Quote vs. thought as a note type, and passage capture
- Photo of a page with OCR — implies image retention, which is out of scope
- TTS playback of notes; the server has Kokoro and `/v1/audio/speech` already
- Streaming transcription via `/v1/realtime`; documented as currently suspended
- Web Push on transcription completion (works on iOS 16.4+ for installed PWAs)
- App Check, if a public endpoint is ever added
- Sharing books or notes with anyone else
- Chunking audio for notes longer than ten minutes
- Semantic search using `/v1/llm/embeddings`
