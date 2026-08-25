#!/usr/bin/env node
/**
 * The export frontmatter, checked against what `SPEC §11` says it is.
 *
 *   node --experimental-strip-types scripts/check-export-format.mjs
 *
 * **This exists because the M7 harness that supposedly guarded the format is not in the
 * tree.** That session's note says "the spec and the renderer cannot drift without that
 * diff failing" — a true statement about a script nobody committed, so the guard has been
 * absent ever since. Adding five keys to the block ADR-020 fixed is a poor moment to keep
 * relying on it.
 *
 * It can run at all only because `markdown.ts` **imports nothing** — no `Timestamp`, no
 * `@/` alias, no `NoteWithId`. `--experimental-strip-types` erases type annotations but
 * cannot resolve a path alias, so a single value import on that side would put the renderer
 * out of reach of the only check that proves its output.
 *
 * The two fixtures are a pair on purpose. Asserting that a full book emits the keys proves
 * nothing on its own: a renderer emitting `subtitle:` unconditionally passes it. "Omitted
 * when absent" is the actual new rule, so the empty book is the fixture that tests it —
 * and this project has now been bitten three times by a control that could not fail (M5's
 * precache check finding zero entries and reporting PASS, M6's two-query test that could
 * not tell its queries apart, M7's UTF-8 zip control agreeing with the bug it existed to
 * catch).
 */

import { bookMarkdown } from '../src/lib/markdown.ts'

let failures = 0

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

const NOTE = {
  chapter: 12,
  chapterTitle: 'The Science of Availability',
  recordedAt: new Date(2026, 7, 19, 9, 41),
  text: 'The availability heuristic is not a bug.',
}

const EXPORTED_ON = new Date(2026, 7, 19)

function frontmatterOf(markdown) {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown)
  return match ? match[1].split('\n') : []
}

// ---------------------------------------------------------------------------------------
// Fixture 1 — everything present, including the shapes that break YAML
// ---------------------------------------------------------------------------------------

console.log('\nFull book\n')

const full = bookMarkdown(
  {
    title: 'Thinking, Fast and Slow',
    authors: ['Daniel Kahneman'],
    isbn13: '9780374533557',
    subtitle: 'Timeless Lessons on Wealth, Greed, and Happiness',
    publishYear: 2013,
    pageCount: 499,
    publisher: 'Farrar, Straus and Giroux',
    // The first carries a comma and the second a quote — both real hazards. A bare flow
    // sequence splits the first into two entries; an unescaped quote ends the scalar and
    // takes the whole block with it (ADR-020).
    subjects: ['77.32 intelligence, creativity', 'The "availability" heuristic', 'Intuition'],
  },
  [NOTE],
  EXPORTED_ON,
)

const fullLines = frontmatterOf(full)

check('frontmatter block is present', fullLines.length > 0, 'no --- fence found')
check('title', fullLines.includes('title: "Thinking, Fast and Slow"'))
check(
  'subtitle',
  fullLines.includes('subtitle: "Timeless Lessons on Wealth, Greed, and Happiness"'),
)
check('author', fullLines.includes('author: "Daniel Kahneman"'))
check('isbn', fullLines.includes('isbn: "9780374533557"'))
check('publisher', fullLines.includes('publisher: "Farrar, Straus and Giroux"'))
check('year is a bare number', fullLines.includes('year: 2013'))
check('pages is a bare number', fullLines.includes('pages: 499'))
check(
  'subjects are quoted scalars in a flow sequence',
  fullLines.includes(
    'subjects: ["77.32 intelligence, creativity", "The \\"availability\\" heuristic", "Intuition"]',
  ),
  fullLines.find((line) => line.startsWith('subjects:')) ?? 'no subjects line',
)
check('tags is still the bare literal', fullLines.includes('tags: [book-notes]'))
check('exported is a bare ISO date', fullLines.includes('exported: 2026-08-19'))

// The keys ADR-020 fixed must keep their order, since a diff against the spec's sample is
// the point of having a fixed format at all.
const order = fullLines.filter((line) => /^[a-z]+:/.test(line)).map((line) => line.split(':')[0])
check(
  'key order matches SPEC §11',
  JSON.stringify(order) ===
    JSON.stringify([
      'title',
      'subtitle',
      'author',
      'isbn',
      'publisher',
      'year',
      'pages',
      'subjects',
      'tags',
      'exported',
    ]),
  order.join(', '),
)

// ---------------------------------------------------------------------------------------
// Fixture 2 — the paired negative. This is the one that tests the new rule.
// ---------------------------------------------------------------------------------------

console.log('\nBook with nothing but a title — the absent-key control\n')

const bare = bookMarkdown(
  {
    title: 'Untitled book',
    authors: [],
    isbn13: null,
    subtitle: null,
    publishYear: null,
    pageCount: null,
    publisher: null,
    subjects: [],
  },
  [NOTE],
  EXPORTED_ON,
)

const bareLines = frontmatterOf(bare)

for (const key of ['subtitle', 'author', 'isbn', 'publisher', 'year', 'pages', 'subjects']) {
  check(
    `${key} is omitted, not emitted blank`,
    !bareLines.some((line) => line.startsWith(`${key}:`)),
    bareLines.find((line) => line.startsWith(`${key}:`)),
  )
}

check(
  'a book with no metadata still emits exactly title, tags and exported',
  JSON.stringify(bareLines) ===
    JSON.stringify(['title: "Untitled book"', 'tags: [book-notes]', 'exported: 2026-08-19']),
  bareLines.join(' | '),
)

// ---------------------------------------------------------------------------------------

console.log(failures === 0 ? '\nExport format OK.\n' : `\n${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
