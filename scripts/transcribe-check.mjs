#!/usr/bin/env node
/**
 * Exercises the real `transcribe()` against a stub speech server.
 *
 * **What this guards is note loss, not formatting.** `transcribe` asks for
 * `response_format: verbose_json` to get the `duration` and per-segment timings that
 * locate a hole in a transcript — and `stt_rejected` is in `pipeline.ts`'s
 * `TERMINAL_CODES`, where a terminal failure discards the recording. So if this speech
 * server does not implement `verbose_json` and the fallback to plain `json` is ever
 * broken, **every note becomes permanently unrecoverable**. That is not a path anyone
 * should verify by reading it, and it cannot be verified against the real server from a
 * machine without the credentials.
 *
 * The stub also pins the two things a careless "fix" would get wrong in opposite
 * directions: a 5xx must *not* re-upload the audio (the backoff queue owns retries, and
 * the blob can be 25 MB), while a 4xx must try both formats before giving up.
 *
 * Runs against the **compiled** output, so it tests what actually deploys:
 *
 *   pnpm --filter marginalia-functions build
 *   node scripts/transcribe-check.mjs
 *
 * Written 2026-08-25, alongside the investigation into a note that came back as
 * `1, 2, 3, 4, 5, 16, 17, 18, 19, 20` — a hole in the middle, which ruled out both of
 * the hypotheses recorded until then.
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const compiled = join(here, '..', 'functions', 'lib', 'speech.js')

if (!existsSync(compiled)) {
  console.error(
    `Missing ${compiled}\nBuild the functions package first:\n\n  pnpm --filter marginalia-functions build\n`,
  )
  process.exit(1)
}

const { transcribe } = createRequire(import.meta.url)(compiled)

let handler = () => {}
let hits = []

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk.toString('latin1')
  })
  req.on('end', () => {
    // Which format each attempt asked for — the multipart body is plain enough to read.
    const match = /name="response_format"\r?\n\r?\n([a-z_]+)/.exec(body)
    hits.push(match ? match[1] : '(none)')
    handler(req, res, hits.length)
  })
})

const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const cfg = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key' }
  const input = {
    audio: new Uint8Array([1, 2, 3, 4]),
    filename: 'n.m4a',
    contentType: 'audio/mp4',
    model: 'Systran/faster-distil-whisper-small.en',
    prompt: 'Notes on "X".',
  }

  // A — verbose_json answered, with a hole in the middle. The shape of the real symptom.
  hits = []
  handler = (_req, res) =>
    json(res, 200, {
      text: '  1, 2, 3, 4, 5, 16, 17, 18, 19, 20.  ',
      duration: 61.5,
      segments: [
        { start: 0.0, end: 7.5 },
        { start: 7.5, end: 12.0 },
        { start: 46.0, end: 61.5 }, // a 34s hole starting at 12.0
      ],
    })
  let result = await transcribe(cfg, input)
  check('A format is verbose_json', result.format === 'verbose_json', result.format)
  check('A text trimmed', result.text === '1, 2, 3, 4, 5, 16, 17, 18, 19, 20.')
  check('A decodedSec parsed', result.decodedSec === 61.5, String(result.decodedSec))
  check('A segmentCount', result.segmentCount === 3, String(result.segmentCount))
  check('A largest gap measured', result.largestGapSec === 34, String(result.largestGapSec))
  check('A gap located', result.largestGapAtSec === 12, String(result.largestGapAtSec))
  check('A uploaded once', hits.length === 1, hits.join(','))

  // B — THE ONE THAT MATTERS. verbose_json refused, so the note must still transcribe.
  //
  // Caught rather than left to propagate: a broken fallback throws `stt_rejected` here,
  // and letting that escape would abort the run and skip C through F. Verified by
  // deliberate mutation on 2026-08-25 — replacing the fallback condition with `false`
  // turns all four of these red and nothing else, which is what makes them worth having.
  hits = []
  handler = (_req, res, hit) =>
    hit === 1
      ? json(res, 422, { detail: 'unsupported response_format' })
      : json(res, 200, { text: 'a transcript' })
  try {
    result = await transcribe(cfg, input)
    check('B falls back to json', result.format === 'json', result.format)
    check('B transcript survives', result.text === 'a transcript', result.text)
    check('B timings null, not invented', result.decodedSec === null && result.segmentCount === null)
    check('B verbose first, then json', hits.join(',') === 'verbose_json,json', hits.join(','))
  } catch (err) {
    check('B falls back to json', false, `threw ${err.code ?? err.message} — a 4xx on verbose_json must not be terminal`)
    check('B transcript survives', false, 'no transcript returned')
    check('B timings null, not invented', false, 'unreachable')
    check('B verbose first, then json', false, hits.join(','))
  }

  // C — a 5xx is the server being down. Re-uploading would double a 25 MB body.
  hits = []
  handler = (_req, res) => json(res, 503, { detail: 'origin down' })
  let code = ''
  try {
    await transcribe(cfg, input)
  } catch (err) {
    code = err.code ?? 'none'
  }
  check('C throws stt_unavailable', code === 'stt_unavailable', code)
  check('C uploaded once only', hits.length === 1, hits.join(','))

  // D — a genuine 4xx still reaches the terminal code, after trying both.
  hits = []
  handler = (_req, res) => json(res, 400, { detail: 'bad model' })
  code = ''
  try {
    await transcribe(cfg, input)
  } catch (err) {
    code = err.code ?? 'none'
  }
  check('D throws stt_rejected', code === 'stt_rejected', code)
  check('D tried both formats', hits.join(',') === 'verbose_json,json', hits.join(','))

  // E — numeric strings and junk rows. This parses an API we cannot test against.
  hits = []
  handler = (_req, res) =>
    json(res, 200, {
      text: 'x',
      duration: '30.25',
      segments: [
        { start: '10', end: '20' },
        null,
        { start: 0, end: 5 },
        { start: 'nope', end: 3 },
      ],
    })
  result = await transcribe(cfg, input)
  check('E numeric-string duration', result.decodedSec === 30.25, String(result.decodedSec))
  check('E junk segments dropped', result.segmentCount === 2, String(result.segmentCount))
  check('E sorted before diffing', result.largestGapSec === 5, String(result.largestGapSec))

  // F — no segments at all must give null, never NaN.
  hits = []
  handler = (_req, res) => json(res, 200, { text: 'x', duration: 3 })
  result = await transcribe(cfg, input)
  check('F no segments → null gap', result.largestGapSec === null && result.segmentCount === null)

  server.close()

  // Every assertion above passing is only meaningful if one can fail. See the vault's
  // Planning lesson: an absent-check with no present-control passed for M5 against a
  // parser that found zero entries.
  const expected = 19
  const ran = expected
  console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${ran - failures}/${ran} checks passed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
