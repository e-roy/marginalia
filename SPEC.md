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
| Cleanup | One LLM polish over the verbatim transcript. Raw always retained. |
| Reading back | Same app with a desktop layout, plus per-book Markdown export |
| Audio retention | Transient at every hop, deleted the moment a transcript commits. A note that gave up keeps its audio so **Try again** can work, and the bucket lifecycle rule reclaims it after about a day. |
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
5. **Retry.** `retrySweep` runs every 5 minutes and re-runs step 3 for notes
   that are stuck, bounded by `attempts < 6`. When the Mac Mini wakes, the
   backlog drains itself.

   **Three queries, because there are three ways to get stuck.** All are
   collection-group queries over `notes`, so their indexes need
   `COLLECTION_GROUP` scope — not the same index a per-user query would use.

   - `pending` with `nextAttemptAt <= now` — the backoff queue.
   - `transcribing` with `updatedAt` older than 10 minutes — a run killed
     mid-note. `transcribeNote` only takes a stale lock over when a redelivery
     arrives; when the crash killed the delivery too, this is the only thing
     that ever looks again.
   - `pending` with `nextAttemptAt == null` and `updatedAt` older than the
     grace window — the note nothing ever wrote to. A Firestore inequality is
     type-scoped and **skips `null` entirely** (measured 2026-08-22), so the
     first query cannot see the very notes ADR-008 is about.

   Results are deduped by document path before processing, so a note can never
   be transcribed twice in one pass.

   **A wall-clock budget, not a fixed count.** The loop stops *starting* notes
   after `BUDGET_MS`, leaving the note in flight room to finish:
   `BUDGET_MS (100s) + worst single note (155s + 25s I/O) + overhead (20s) ≤
   timeoutSeconds (300s) ≤ the 5-minute interval`. Too generous a budget would
   let a killed run count an attempt without completing a request, and a note
   could reach `failed` having never been transcribed once.

   `failed` is terminal, and a failure becomes terminal two ways, which differ
   in what happens to the audio:

   - **The request will fail identically next time** — `stt_rejected`,
     `no_stt_model`, `audio_too_large`, `audio_missing`. The audio is deleted
     immediately, because nothing will ever read it again.
   - **The attempts ran out.** The recording is fine and the server was not, so
     the audio is **kept** and **Try again** on the Note screen resets the note
     (`pending`, `attempts: 0`, `nextAttemptAt: now`) for the sweep to collect.
     The bucket lifecycle rule reclaims it after about a day (§10).

   A retryable failure goes back to `pending` with an exponential
   `nextAttemptAt` and keeps its audio.

   **The sweep issues one verdict of its own:** a dead lock that has already
   exhausted its attempts is written `failed` with `run_interrupted`, keeping
   its audio. Without it that note would be taken over every ten minutes
   forever — the classifier that would have given up was the thing being
   killed — and never reach the state where Try again is offered.

   **A crash is a different category and needs a different owner.** An
   application failure is caught, recorded on the note, and rescheduled by the
   sweep — the handler returns normally, so Eventarc sees a success. A crash
   writes nothing at all: no attempt, no error, nothing for the sweep to find.
   So `transcribeNote` sets `retry: true` and lets Eventarc redeliver, and
   treats a `transcribing` lock older than ten minutes as dead and takes it
   over. Without both, a single dropped delivery strands a note in `pending`
   forever — and in the UI that is indistinguishable from one still in
   progress.

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
  llmOk: boolean;              // the model list came back — NOT that any will answer
  llmProbed: string | null;    // the model actually tested
  llmUsable: boolean;          // it answered
  stt: string[];               // model ids
  llm: string[];               // model ids
  checkedAt: string;
}
```

**Listing is not proof, so the cleanup model is actually used.** Measured
2026-08-21 and again 2026-08-22: `GET /v1/llm/models` returns every model in
about half a second while `gemma4:12b` — the model auto-pick chooses — either
502s after ~21s or never answers at all. `llmOk` was `true` throughout. So
`serverHealth` resolves the model this user's next note *would* use (the pinned
one, or auto-pick) and sends a minimal chat completion.

The probe's budget is the polish's own 45s, deliberately: anything shorter would
report "not answering" for a model the pipeline would have used successfully.
That sets the deadline stack — 45s probe inside the function's 120s inside the
client's 150s.

The probe **reports**; it does not choose. Changing what auto-pick selects is a
separate decision (see the backlog), and this exists so that decision has
evidence.

Called from Settings, and once on the first transcription of a cold start.

### Auto-pick when nothing is chosen

- **STT:** first id matching `/whisper/i`, explicitly excluding `/kokoro/i` —
  the TTS model is preloaded alongside the STT models and will appear in the
  same list.
- **LLM:** first available id. If the list is empty or `llmOk` is false, skip
  the polish entirely and keep the verbatim transcript.

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
  openLibraryKey: string | null;  // search → work key "/works/OL45804W";
                                  // barcode scan → edition key "/books/OL…M"
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
  cleanText: string | null;   // the LLM polish; null when it did not run
  title: string | null;       // LLM-suggested, 5-8 words
  edited: boolean;            // once hand-edited, re-polish won't overwrite

  durationMs: number | null;  // null for text notes
  recordedAt: Timestamp;      // client clock at record time — the real one
  transcribedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;

  sttModel: string | null;    // what was actually used, recorded after the fact
  llmModel: string | null;    // null if polish was skipped or rejected

  audioPath: string | null;   // nulled when the object is deleted, kept when it gave up
  attempts: number;
  // Earliest time anyone should look at this note again. Written by the failure
  // classifier, and stamped by the client at upload — an unstamped note is invisible
  // to a `<=` range query, which is what retrySweep's third query exists to catch.
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
- `notes`: `recordedAt DESC` — home feed
- `books`: `lastNoteAt DESC` — recent-books strip

`retrySweep` runs across every user, so its indexes are **`COLLECTION_GROUP`**
scope. A `COLLECTION`-scoped index of the same fields cannot serve a
`collectionGroup('notes')` query at all:

- `notes`: `status ASC, nextAttemptAt ASC` — the backoff queue
- `notes`: `status ASC, nextAttemptAt ASC, updatedAt ASC` — the unstamped backstop
- `notes`: `status ASC, updatedAt ASC` — dead locks

The first two are **not** redundant, and assuming they were is what broke the first
deployed sweep. A composite index orders its entries by every field in turn and then by
`__name__`. The backoff query orders by `nextAttemptAt, __name__`, so it needs an index
where `__name__` comes straight after `nextAttemptAt`; in the three-field index
`updatedAt` sits between them, and Firestore rejects the query with
`FAILED_PRECONDITION`. Prefix matching covers *filters*, not the trailing sort position.

`attempts < 6` is applied in code rather than as a second inequality filter,
which would otherwise have to join every one of these indexes and every
`orderBy`. The count of failed notes on the Now screen is a single equality
filter, served by Firestore's automatic single-field index.

---

## 7. The cleanup pipeline

Two stages inside `transcribeNote`, for voice notes only. Stage 2 may fail without
losing the note.

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

### Stage 2 — Light LLM polish

`POST /v1/llm/chat/completions`, non-streaming — the function isn't feeding a
UI. `temperature: 0.2`. Model from settings or auto-picked.

System prompt:

> You clean up voice-note transcripts. The speaker is dictating notes about a
> book they are reading. Fix punctuation, capitalization, and paragraph breaks.
> Remove filler words, hesitations, and false starts. Preserve the speaker's own
> words, first person, and meaning exactly. Never add facts. Never summarize.
> Never answer questions that appear in the text — they are the speaker's own
> notes to themselves. Reply with JSON only:
> `{"text": string, "title": string}` where title is a 5-8 word summary.

**The model is given `rawText`, verbatim.** There was once a deterministic filler
strip in front of it; ADR-016 removed it. Anything a regex deletes is deleted from
the model's evidence too and it cannot ask for it back — and a repeated-word rule
turns "I had had enough" into "I had enough", "no no no" into "no". Telling a false
start from emphasis is a judgement about meaning: what the system prompt is for, and
what a regex can never do.

**Two guardrails, both mandatory:**

1. **Length gate.** If the returned text is shorter than 60% or longer than
   140% of `rawText`, discard the polish and set both `cleanText` and
   `llmModel` to null. This is what stops a small model from quietly summarizing a
   note into oblivion — the most likely failure mode in the whole system.
2. **Reasoning-block strip.** Reasoning models emit `<think>…</think>`. Strip
   those before parsing JSON. Since the model is whatever Ollama has pulled,
   assume this rather than testing for it.

If the LLM is unreachable the note still completes, with `cleanText: null`; the UI
reads `cleanText ?? rawText`, so it shows the transcript. Polish is always
best-effort and never blocks a transcript. A **Re-polish** action on the note screen
re-runs it on demand — also how notes captured while Ollama was down get cleaned up
later.

**Re-polish is the one place best-effort does not apply.** It writes only when
the polish actually produced text; otherwise it writes nothing and reports
`llm_unavailable`. Swallowing the failure is right on the automatic path, where
the alternative is losing a transcript — but on an explicit request the
alternative is the note the user already had, and answering a tap by replacing a
good polish with a blank would make the note worse. It is offered on any
voice note that is `done`, not `edited`, and has a non-empty `rawText`; the
empty case is excluded because the length gate rejects every result measured
against a zero-length base.

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
- **Which book is selected is device-local**, held in `localStorage` under
  `marginalia.selectedBook`, falling back to the most recently touched book when it
  is missing or names a book that no longer exists. It is a resume pointer for one
  phone, not user data — two devices may be mid-different-book, and switching should
  not cost a Firestore write per tap. `currentChapter` is the opposite case and lives
  on the book document, because it is per-book state the stepper mutates and the
  Whisper prompt is built from.
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
| Book | Chapters with note counts; notes grouped by chapter; add titles; filter this book's notes; export; delete book. On a wide viewport a sticky chapter index sits beside the notes |
| Note | Clean text (editable), raw toggle, re-polish, move chapter, delete |
| Scan | Camera barcode scanner (lazy route) |
| Search | Client-side across all notes |
| Settings | Server health, model pickers, export, sign out |

Search is client-side on purpose. Firestore has no full-text search, a single
reader's lifetime of notes is a few megabytes, and Firestore persistence has
already cached them. Algolia would be cost and complexity for nothing.

It exists in two places, over one matcher. The Search screen spans every book; the
Book screen filters that book's notes **in place**, so the chapter structure survives
— chapters with no match drop out of the index and the column together. Both are
case-insensitive substring matching, AND across words, over what is actually on
screen (`cleanText ?? rawText`, the note's title, the book's title).

A note carries the **date** as well as the time everywhere except the Now screen's
feed, which is filtered to today by construction. A bare `9:41 AM` on a note from
three weeks ago names a moment without saying which day.

---

## 9. Adding a book

Three paths into the same form. All of them end editable, because metadata is
frequently wrong and you should never be stuck.

### ISBN barcode scan

Lazy-loaded route (`/scan`), and the app's only one. Measured after M5, the
decoder chunk is **477 KB raw / 125 KB gzip** — comfortably the largest thing
that is not the Firebase SDK, and it must never touch the capture bundle.

**Decoder — ZXing only.** `@zxing/browser`'s `BrowserMultiFormatOneDReader`,
hinted to `EAN_13` via `DecodeHintType.POSSIBLE_FORMATS`. There is deliberately
no native `BarcodeDetector` branch: Safari has never shipped the API, so on the
primary target (ADR-005) ZXing is the only path the code can take; Chrome on
Windows — where this is built and verified — has no support either, so the dev
browser and the phone run the same decoder. The only beneficiary would be
Android Chrome, which ADR-005 keeps functional but does not design for, and the
native branch is the one that could never be exercised on any device this
project has. TypeScript 7 does not declare `BarcodeDetector` at all, so the
branch would also need a hand-written type declaration.

`@zxing/library` is a **direct** dependency, not just a transitive one:
`@zxing/browser` re-exports only `BarcodeFormat`, and pnpm's strict linking will
not resolve an app import of `DecodeHintType` through the parent package.

**Camera.** `getUserMedia({ video: { facingMode: 'environment' } })` — a plain
value, never `exact`, so a device without a rear camera falls back instead of
throwing `OverconstrainedError`. HTTPS required, which Firebase Hosting gives.
Render the `<video>` element ourselves with **`playsInline muted autoPlay`** and
hand it to `decodeFromConstraints`; without `playsInline`, iOS Safari hoists the
stream into its native fullscreen player and the viewfinder disappears.

**Teardown is three calls, and only one of them releases the camera.**
`controls.stop()` ends the decode loop, `BrowserCodeReader.releaseAllStreams()`
stops the tracks, `cleanVideoSource()` detaches the element. `cleanVideoSource`
alone nulls `srcObject` and never touches a track, so omitting
`releaseAllStreams` leaves the hardware live behind the navigation and the iOS
camera indicator lit. Runs on unmount, on a successful scan, and on
`visibilitychange` → hidden; the restart on `visible` is guarded to the
`scanning` state, or a scan that is mid-lookup would restart the camera just in
time to navigate away with it running.

**Validate before looking up.** Book barcodes are EAN-13 starting `978` or
`979`. Check the ISBN-13 checksum and reject anything else — misreads are common
and a bad lookup wastes a round trip and confuses the user. A rejected read is
silent and scanning continues; anything else means flashing an error at someone
still bringing the barcode into frame. Note the format's own blind spot: the
alternating 1/3 weighting cannot detect two adjacent digits swapped when they
differ by exactly 5.

**Lookup.** One call, returns title, authors, and cover:

```
https://openlibrary.org/api/books?bibkeys=ISBN:{isbn13}&format=json&jscmd=data
```

The response shape is **not** the search shape, verified against live data:
the body is keyed by the literal string `ISBN:{isbn13}` and **a missing key is
how "not found" arrives** — there is no 404; `authors` are objects carrying a
`name`, and real records repeat an author under two keys, so deduplicate;
`cover` holds complete URLs rather than the numeric `cover_i` search returns;
and `key` is an **edition** key (`/books/OL…M`), not a work key. `publish_date`
is a string, so no publication year is recorded from this path.

Not found is normal, not an error. Prefill the ISBN, let the user type the rest.
A timed-out or rate-limited lookup lands in exactly the same place.

### Open Library search

```
https://openlibrary.org/search.json?q={q}&fields=key,title,author_name,cover_i,first_publish_year&limit=8
```

CORS-enabled, no API key, called directly from the browser. Debounce 300ms.
Cover art: `https://covers.openlibrary.org/b/id/{cover_i}-M.jpg`.

**Both Open Library calls carry their own deadline** — 8s for search, 12s for
the ISBN lookup, composed with the caller's `AbortSignal` via `AbortSignal.any`.
This is not theoretical: `search.json` has been observed timing out at ~21s
reproducibly from a machine where `api/books` answered in under 4s. Without a
deadline the sheet spins forever and never reaches "add it by hand", which is
the fallback the whole section is built around. A superseded keystroke still
resolves empty; a timeout must not, or the user gets a permanently blank list
instead of the fallback.

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

- A bucket lifecycle rule deletes anything under `users/` older than one day.
  It covers the two cases `transcribeNote`'s own delete cannot: a run that
  crashed before it, and a note that **gave up after six attempts and
  deliberately keeps its audio** so that Try again has something to act on
  (§4). The second is what makes this rule load-bearing rather than tidy —
  without it, failed notes would accumulate audio with nothing to reclaim it.
  Applied with `pnpm storage:lifecycle`; it is a bucket setting, so
  `firebase deploy` cannot carry it.

  GCS evaluates lifecycle asynchronously, so `age: 1` means **about** a day
  rather than exactly 24 hours. Overstating that precision in a public repo
  would be worse than the extra day.
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
