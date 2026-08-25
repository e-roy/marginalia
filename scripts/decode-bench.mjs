#!/usr/bin/env node
/**
 * Headless barcode decode benchmark (`SPEC §9`).
 *
 * The roadmap's instruction for the scanner's hit rate was "start by measuring which books
 * fail, rather than guessing which knob". A shelf of real books is the ground truth, but it
 * is slow, unrepeatable, and cannot isolate a variable — so this decides *which knob* and
 * the phone confirms the result.
 *
 * **It runs the production decode path minus the camera.** Production is
 * `HTMLCanvasElementLuminanceSource → HybridBinarizer → BinaryBitmap →
 * MultiFormatOneDReader.decode(bitmap, hints)`. This swaps only the first, for an
 * `RGBLuminanceSource` over a frame it renders itself. Same binarizer, same reader, same
 * hints, hints passed in both the places `BrowserCodeReader` passes them — so a result
 * about hints or about pixels-per-module transfers.
 *
 * **Why this file exists at all, rather than being a throwaway.** M5 wrote an EAN-13
 * encoder to prove the scan seam and M7 wrote a SPEC-diffing format harness; neither was
 * committed, so the second time either question came up the work was gone. Writing the
 * encoder for the second time in this project is the argument for keeping it.
 *
 *   node scripts/decode-bench.mjs              # the matrix
 *   node scripts/decode-bench.mjs --self-test  # the controls, exits non-zero on failure
 *   node scripts/decode-bench.mjs --trials 8   # more samples per cell
 *
 * Reading the numbers: rank configurations by **expected time to first decode**,
 * `(median decode ms + SCAN_ATTEMPT_INTERVAL_MS) / decode rate`. The interval is a gap
 * *after* each attempt rather than a budget the decode must fit inside — `BrowserCodeReader`
 * schedules the next loop from its `catch`, once the attempt has already returned. So a
 * slower attempt does not fail, it just buys fewer tries per second, and a knob earns its
 * place when it wins more successes than it costs in cycle time.
 *
 * These are desktop Node milliseconds against an iPhone target (ADR-005). Use them to
 * **rank** configurations, never as an absolute budget; whether the viewfinder still feels
 * alive is a question only the phone answers.
 *
 * ---
 *
 * **READ THIS BEFORE TRUSTING THE `+TRY_HARDER` COLUMN. It has already been wrong once, and
 * it was wrong in the direction that ships a broken scanner.**
 *
 * On 2026-08-24 this benchmark recommended `TRY_HARDER` — 26 cells to 7, and a vertically
 * held book going from a 0% decode rate to 100%. It was shipped, deployed, and made the
 * viewfinder go **black on a real iPhone**: the camera flashes once and the page never
 * paints again. Reverted the same day.
 *
 * The gap is `RotatableLuminanceSource` below. It fakes rotation with a typed-array
 * transpose, which is nothing like what production does — `HTMLCanvasElementLuminanceSource`
 * resizes a temp canvas, performs a rotated `drawImage`, and then re-runs `getImageData`
 * over the whole frame and rebuilds the greyscale buffer. `TRY_HARDER` triggers that on
 * **every failed attempt**, on top of scanning ~14× as many rows and then scanning the
 * entire rotated frame again. So the timing column understates it by a wide and
 * *unquantified* margin.
 *
 * The rule that follows: this harness ranks configurations on **decode rate**, which is
 * hardware-independent and is what it is good for. It cannot tell you whether a
 * configuration is affordable on a phone. Any hint that changes per-attempt work — above
 * all one that touches the rotate path — is a **phone test before it is a commit**, not
 * after.
 */

import pkg from '@zxing/library'

// Named ESM imports do NOT work here: Node resolves `@zxing/library` to its UMD/CommonJS
// build and cjs-module-lexer cannot see the exports through it, so `import { X } from …`
// fails at link time with "Named export not found". The default import is what Node's own
// error message recommends, and it is the only form that works.
const {
  RGBLuminanceSource,
  HybridBinarizer,
  BinaryBitmap,
  MultiFormatOneDReader,
  DecodeHintType,
  BarcodeFormat,
  EAN13Reader,
} = pkg

/** Matches `SCAN_ATTEMPT_INTERVAL_MS` in `src/routes/Scan.tsx`. */
const SCAN_ATTEMPT_INTERVAL_MS = 300

// ---------------------------------------------------------------------------------------
// EAN-13 encoding
// ---------------------------------------------------------------------------------------

/**
 * The L set (odd parity), as bit strings — 0 is a bar-space and 1 is ink.
 *
 * ZXing's own tables are run-length widths rather than bits, because its reader measures
 * runs. `assertPatternsMatchZXing()` below derives widths back out of these strings and
 * checks them against `L_PATTERNS` off the installed library, so a transcription slip in
 * this table cannot survive `--self-test`.
 */
const L_PATTERNS = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
]

/** R is L inverted — the right half is drawn in the opposite colour sense. */
const R_PATTERNS = L_PATTERNS.map((p) => flipBits(p))

/**
 * G is R reversed (equivalently, L reversed then inverted — the two commute). ZXing builds
 * its G set the same way, by reversing each L width array into slots 10-19 of
 * `L_AND_G_PATTERNS`.
 */
const G_PATTERNS = R_PATTERNS.map((p) => [...p].reverse().join(''))

/**
 * The thirteenth digit is never drawn. It selects which of the six left-hand digits use L
 * and which use G, and the decoder recovers it by recognising the parity word — which is
 * why an encoder with this table wrong still draws a perfectly plausible barcode that
 * decodes to a *different number*. `EAN13Reader.FIRST_DIGIT_ENCODINGS` holds the same ten
 * values as a bit field; `--self-test` checks these against it.
 */
const FIRST_DIGIT_PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
]

const START_END_GUARD = '101'
const MIDDLE_GUARD = '01010'

function flipBits(bits) {
  return [...bits].map((b) => (b === '0' ? '1' : '0')).join('')
}

/** The same weighting `src/lib/isbn.ts` applies, kept here so the script imports nothing app-side. */
function checkDigit(twelve) {
  let sum = 0
  for (let i = 0; i < 12; i += 1) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}

/**
 * Thirteen digits to 95 modules: guard, six left digits in the parity the first digit
 * selects, middle guard, six right digits, guard.
 */
function encodeEan13(digits) {
  if (!/^\d{13}$/.test(digits)) throw new Error(`not 13 digits: ${digits}`)

  const d = [...digits].map(Number)
  const parity = FIRST_DIGIT_PARITY[d[0]]

  let bits = START_END_GUARD
  for (let i = 1; i <= 6; i += 1) {
    bits += (parity[i - 1] === 'L' ? L_PATTERNS : G_PATTERNS)[d[i]]
  }
  bits += MIDDLE_GUARD
  for (let i = 7; i <= 12; i += 1) bits += R_PATTERNS[d[i]]
  bits += START_END_GUARD

  if (bits.length !== 95) throw new Error(`encoded ${bits.length} modules, expected 95`)
  return bits
}

// ---------------------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------------------

/**
 * Draw the barcode into a white frame, area-averaging each pixel's coverage.
 *
 * The averaging matters: at low pixels-per-module a hard nearest-neighbour edge lands
 * either fully black or fully white, which is *kinder* than a camera and would flatter
 * every configuration equally but unrealistically. Averaging gives the soft edges a lens
 * actually produces, so the binarizer has the same job it has in the field.
 *
 * Returns a `Uint8ClampedArray` deliberately: `RGBLuminanceSource` discriminates on
 * `BYTES_PER_ELEMENT` and reads a 4-byte array as packed `0xRRGGBB` rather than as literal
 * luminance.
 */
function renderScene(bits, { frameW, frameH, barcodeFrac, barHeightFrac = 0.42 }) {
  const buf = new Uint8ClampedArray(frameW * frameH).fill(255)

  const barcodeW = frameW * barcodeFrac
  const pxPerModule = barcodeW / bits.length
  const x0 = (frameW - barcodeW) / 2
  const barH = Math.round(frameH * barHeightFrac)
  const y0 = Math.round((frameH - barH) / 2)

  for (let x = Math.floor(x0); x < Math.ceil(x0 + barcodeW); x += 1) {
    if (x < 0 || x >= frameW) continue

    // Coverage of this pixel by ink, in module space.
    const mStart = (x - x0) / pxPerModule
    const mEnd = (x + 1 - x0) / pxPerModule
    let ink = 0
    for (let m = Math.floor(mStart); m < Math.ceil(mEnd); m += 1) {
      if (m < 0 || m >= bits.length || bits[m] === '0') continue
      ink += Math.min(mEnd, m + 1) - Math.max(mStart, m)
    }
    const value = Math.round(255 * (1 - Math.max(0, Math.min(1, ink / (mEnd - mStart)))))

    for (let y = y0; y < y0 + barH; y += 1) {
      if (y >= 0 && y < frameH) buf[y * frameW + x] = value
    }
  }

  return { buf, pxPerModule }
}

// ---------------------------------------------------------------------------------------
// Degradations — pure functions over the greyscale buffer
// ---------------------------------------------------------------------------------------

/** mulberry32. Seeded so a reported number can be reproduced rather than re-rolled. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Three box passes approximate a gaussian closely enough for defocus, and are separable. */
function blur(buf, w, h, radius) {
  if (radius <= 0) return buf
  let src = buf
  for (let pass = 0; pass < 3; pass += 1) {
    src = boxPass(src, w, h, radius, true)
    src = boxPass(src, w, h, radius, false)
  }
  return src
}

/**
 * Sliding-window box pass — O(pixels), independent of radius.
 *
 * The naive form re-summed the window at every pixel, which is O(pixels × radius) and made
 * a scene-scale blur cost seconds per frame. Since the optical blur here is deliberately
 * large (it is applied to a 2560px scene, not a 640px frame), that difference is what makes
 * the whole matrix runnable.
 */
function boxPass(src, w, h, radius, horizontal) {
  const out = new Uint8ClampedArray(src.length)
  const outer = horizontal ? h : w
  const inner = horizontal ? w : h
  const at = (o, i) => (horizontal ? src[o * w + i] : src[i * w + o])

  for (let o = 0; o < outer; o += 1) {
    let sum = 0
    let count = 0
    // Prime the window on [0, radius].
    for (let i = 0; i <= radius && i < inner; i += 1) {
      sum += at(o, i)
      count += 1
    }
    for (let i = 0; i < inner; i += 1) {
      const value = sum / count
      if (horizontal) out[o * w + i] = value
      else out[i * w + o] = value

      const leaving = i - radius
      const entering = i + radius + 1
      if (leaving >= 0) {
        sum -= at(o, leaving)
        count -= 1
      }
      if (entering < inner) {
        sum += at(o, entering)
        count += 1
      }
    }
  }
  return out
}

/** Bilinear rotation about the centre, white outside — a book held at an angle. */
function rotate(buf, w, h, degrees) {
  if (degrees === 0) return buf
  const out = new Uint8ClampedArray(w * h).fill(255)
  const rad = (degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = w / 2
  const cy = h / 2

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx
      const dy = y - cy
      const sx = cos * dx + sin * dy + cx
      const sy = -sin * dx + cos * dy + cy
      if (sx < 0 || sx >= w - 1 || sy < 0 || sy >= h - 1) continue

      const x1 = Math.floor(sx)
      const y1 = Math.floor(sy)
      const fx = sx - x1
      const fy = sy - y1
      const a = buf[y1 * w + x1]
      const b = buf[y1 * w + x1 + 1]
      const c = buf[(y1 + 1) * w + x1]
      const d = buf[(y1 + 1) * w + x1 + 1]
      out[y * w + x] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
    }
  }
  return out
}

/** Compress the dynamic range — a dim shelf, or glare washing the contrast out. */
function contrast(buf, lo, hi) {
  const out = new Uint8ClampedArray(buf.length)
  for (let i = 0; i < buf.length; i += 1) out[i] = lo + (buf[i] / 255) * (hi - lo)
  return out
}

/**
 * Area-average the scene down to the stream resolution — the sensor sampling step.
 *
 * This is the whole reason requesting a bigger stream can help at all, and getting it wrong
 * is what made the first run of this benchmark report that **higher resolution decoded
 * worse**. Applying a fixed-pixel blur directly at each stream size models a different lens
 * per resolution, which is not a camera. A camera has one lens: the optics soften the scene,
 * and only then does the sensor sample it — coarsely at 640, finely at 1920. Degrade the
 * scene once, downsample per resolution, and the comparison means something.
 */
function downsample(buf, srcW, srcH, dstW, dstH) {
  const out = new Uint8ClampedArray(dstW * dstH)
  const xRatio = srcW / dstW
  const yRatio = srcH / dstH

  for (let y = 0; y < dstH; y += 1) {
    const sy0 = Math.floor(y * yRatio)
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * yRatio))
    for (let x = 0; x < dstW; x += 1) {
      const sx0 = Math.floor(x * xRatio)
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * xRatio))
      let sum = 0
      let count = 0
      for (let sy = sy0; sy < sy1 && sy < srcH; sy += 1) {
        for (let sx = sx0; sx < sx1 && sx < srcW; sx += 1) {
          sum += buf[sy * srcW + sx]
          count += 1
        }
      }
      out[y * dstW + x] = count === 0 ? 255 : sum / count
    }
  }
  return out
}

/** Additive gaussian noise — sensor gain in low light, and genuinely per-pixel. */
function noise(buf, sigma, random) {
  if (sigma <= 0) return buf
  const out = new Uint8ClampedArray(buf.length)
  for (let i = 0; i < buf.length; i += 1) {
    const u = Math.max(1e-9, random())
    const v = random()
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    out[i] = buf[i] + g * sigma
  }
  return out
}

// ---------------------------------------------------------------------------------------
// The production luminance path
// ---------------------------------------------------------------------------------------

/**
 * Production builds a fresh `HTMLCanvasElementLuminanceSource` on **every attempt**, and
 * its constructor runs `getImageData` over the whole canvas followed by `toGrayscaleBuffer`
 * across every pixel. That O(w·h) pass is exactly the term that grows when the requested
 * resolution goes up — so handing `RGBLuminanceSource` a ready-made greyscale array would
 * skip the cost of the very knob under test. This runs the same round trip, with ZXing's
 * own coefficients.
 */
function toRgba(buf) {
  const rgba = new Uint8ClampedArray(buf.length * 4)
  for (let i = 0, j = 0; i < buf.length; i += 1, j += 4) {
    rgba[j] = buf[i]
    rgba[j + 1] = buf[i]
    rgba[j + 2] = buf[i]
    rgba[j + 3] = 255
  }
  return rgba
}

function toGrayscaleBuffer(rgba, width, height) {
  const gray = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 1) {
    const alpha = rgba[i + 3]
    gray[j] =
      alpha === 0 ? 0xff : (306 * rgba[i] + 601 * rgba[i + 1] + 117 * rgba[i + 2] + 0x200) >> 10
  }
  return gray
}

/**
 * `TRY_HARDER`'s rotated-90° retry is guarded by `image.isRotateSupported()`.
 * `HTMLCanvasElementLuminanceSource` returns `true`; the base `RGBLuminanceSource` returns
 * `false`. Without this subclass the benchmark would exercise only the row-scanning half of
 * the hint, and would report a 0% decode rate for a vertically held book under both
 * configurations — hiding the one thing `TRY_HARDER` genuinely does better.
 *
 * **It is faithful about decode RATE and badly unfaithful about COST.** Production's rotate
 * is not this transpose: it resizes a temp canvas, does a rotated `drawImage`, then re-reads
 * the whole frame with `getImageData` and rebuilds the greyscale buffer — two full-frame GPU
 * readbacks per failed attempt. That difference is what let this benchmark recommend a hint
 * that blacked out the viewfinder on a real phone (see the header). Left as a transpose
 * deliberately, because a canvas cannot be had in Node; the honest fix is to stop reading
 * the timing column as a phone budget, which the header now says outright.
 */
class RotatableLuminanceSource extends RGBLuminanceSource {
  constructor(gray, width, height) {
    super(gray, width, height)
    this._gray = gray
    this._w = width
    this._h = height
  }

  isRotateSupported() {
    return true
  }

  rotateCounterClockwise() {
    const w = this._w
    const h = this._h
    const out = new Uint8ClampedArray(w * h)
    // Destination is h wide and w tall; column x becomes row (w - 1 - x).
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        out[(w - 1 - x) * h + y] = this._gray[y * w + x]
      }
    }
    return new RotatableLuminanceSource(out, h, w)
  }
}

function hintsFor(config) {
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]]])
  if (config.tryHarder) hints.set(DecodeHintType.TRY_HARDER, true)
  return hints
}

/** One attempt, timed the way production spends it: greyscale conversion included. */
function attemptDecode(gray, width, height, config) {
  const hints = hintsFor(config)
  const reader = new MultiFormatOneDReader(hints)
  const rgba = toRgba(gray)

  const started = performance.now()
  let text
  try {
    const source = new RotatableLuminanceSource(toGrayscaleBuffer(rgba, width, height), width, height)
    const bitmap = new BinaryBitmap(new HybridBinarizer(source))
    // Hints at construction *and* at decode, which is what `BrowserCodeReader` does.
    text = reader.decode(bitmap, hints).getText()
  } catch {
    text = null
  }
  return { text, ms: performance.now() - started }
}

// ---------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------

/** Real ISBNs, chosen so the first digits differ and several parity words get exercised. */
const SAMPLE_ISBNS = [
  '9780374533557',
  '9780262046305',
  '9780857197689',
  '9781400032716',
  '9780141033570',
  '9789023493723',
]

/**
 * The optical image, before the sensor samples it. One scene is degraded once and then
 * downsampled to each stream resolution, which is what makes the resolutions comparable:
 * they differ only in how finely they sample the *same* photograph.
 *
 * 16:9 throughout. A real 640-wide stream is 4:3, but only the width matters to a 1D
 * decoder and a single scene aspect keeps the downsample a pure scale.
 */
const SCENE = { w: 2560, h: 1440 }

/** Requested stream resolutions. `Scan.tsx` requests none today, so 640 is the honest baseline. */
const RESOLUTIONS = [
  { label: '640 (default)', w: 640, h: 360 },
  { label: '1280', w: 1280, h: 720 },
  { label: '1920', w: 1920, h: 1080 },
]

/** How much of the frame width the barcode spans — the holding-distance proxy. */
const DISTANCES = [
  { label: 'near', frac: 0.6 },
  { label: 'mid', frac: 0.4 },
  { label: 'far', frac: 0.25 },
]

/**
 * Lens softness as a fraction of image width, so it is a property of the optics rather than
 * of the resolution it is later sampled at. ~0.3% of 2560 is 8px at scene scale — about
 * half a module with the barcode held near.
 */
const SOFT_FOCUS_RADIUS = Math.round(SCENE.w * 0.003)

/**
 * `optics` runs on the scene, before sampling; `sensor` runs on the sampled frame, because
 * read noise is per-pixel and belongs to the sensor rather than the lens.
 */
const CONDITIONS = [
  { label: 'clean', optics: (buf) => buf },
  { label: 'soft focus', optics: (buf, w, h) => blur(buf, w, h, SOFT_FOCUS_RADIUS) },
  { label: 'tilted 15°', optics: (buf, w, h) => rotate(buf, w, h, 15) },
  { label: 'sideways 85°', optics: (buf, w, h) => rotate(buf, w, h, 85) },
  {
    label: 'dim + grain',
    optics: (buf) => contrast(buf, 60, 190),
    sensor: (buf, random) => noise(buf, 12, random),
  },
]

const CONFIGS = [
  { label: 'baseline', tryHarder: false },
  { label: '+TRY_HARDER', tryHarder: true },
]

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Degraded scenes are expensive and depend on nothing about the stream resolution, so they
 * are built once and shared. Without this the matrix re-blurs a 3.7-megapixel scene for
 * every resolution and every config that reads it.
 */
const sceneCache = new Map()

function degradedScene(isbn, distance, condition, seed) {
  const key = `${isbn}|${distance.label}|${condition.label}`
  const cached = sceneCache.get(key)
  if (cached) return cached

  const { buf } = renderScene(encodeEan13(isbn), {
    frameW: SCENE.w,
    frameH: SCENE.h,
    barcodeFrac: distance.frac,
  })
  const scene = condition.optics(buf, SCENE.w, SCENE.h, rng(seed))
  sceneCache.set(key, scene)
  return scene
}

function runCell(resolution, distance, condition, config, trials) {
  let hits = 0
  const times = []

  for (let t = 0; t < trials; t += 1) {
    const isbn = SAMPLE_ISBNS[t % SAMPLE_ISBNS.length]
    const seed = 0x5eed + t * 7919

    const scene = degradedScene(isbn, distance, condition, seed)
    // The sensor step: sample the scene at this resolution, then add read noise, which is
    // per-pixel and so must come after sampling rather than before it.
    const sampled = downsample(scene, SCENE.w, SCENE.h, resolution.w, resolution.h)
    const frame = condition.sensor ? condition.sensor(sampled, rng(seed)) : sampled

    const { text, ms } = attemptDecode(frame, resolution.w, resolution.h, config)
    times.push(ms)
    // A decode that returns the WRONG number is a miss, not a hit. Counting "something
    // decoded" would let an encoder bug read as success.
    if (text === isbn) hits += 1
  }

  const rate = hits / trials
  const medianMs = median(times)
  return {
    rate,
    medianMs,
    // Expected time to a first decode: cycle time divided by per-attempt success.
    expectedMs: rate === 0 ? Infinity : (medianMs + SCAN_ATTEMPT_INTERVAL_MS) / rate,
  }
}

function pxPerModuleFor(resolution, distance) {
  return (resolution.w * distance.frac) / 95
}

function runMatrix(trials) {
  console.log(`\nEAN-13 decode benchmark — ${trials} trials per cell`)
  console.log(`Cycle time assumes SCAN_ATTEMPT_INTERVAL_MS = ${SCAN_ATTEMPT_INTERVAL_MS}\n`)

  const wins = { baseline: 0, '+TRY_HARDER': 0 }

  for (const resolution of RESOLUTIONS) {
    for (const distance of DISTANCES) {
      const ppm = pxPerModuleFor(resolution, distance).toFixed(1)
      console.log(`── ${resolution.label} · ${distance.label} · ${ppm} px/module`)

      for (const condition of CONDITIONS) {
        const cells = CONFIGS.map((config) => ({
          config,
          ...runCell(resolution, distance, condition, config, trials),
        }))

        const best = cells.reduce((a, b) => (b.expectedMs < a.expectedMs ? b : a))
        if (Number.isFinite(best.expectedMs)) wins[best.config.label] += 1

        const rendered = cells
          .map((cell) => {
            const rate = `${Math.round(cell.rate * 100)}%`.padStart(4)
            const ms = `${cell.medianMs.toFixed(0)}ms`.padStart(6)
            const exp = Number.isFinite(cell.expectedMs)
              ? `${cell.expectedMs.toFixed(0)}ms`.padStart(7)
              : '      —'
            const mark = cell === best && Number.isFinite(cell.expectedMs) ? '*' : ' '
            return `${cell.config.label.padEnd(12)} ${rate} ${ms} → ${exp}${mark}`
          })
          .join('   |   ')

        console.log(`   ${condition.label.padEnd(13)} ${rendered}`)
      }
      console.log('')
    }
  }

  console.log('Columns: decode rate · median attempt ms · expected time to first decode')
  console.log('* marks the lower expected time in that row.\n')
  console.log(`Cells won — baseline: ${wins.baseline} · +TRY_HARDER: ${wins['+TRY_HARDER']}\n`)
}

// ---------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------

/**
 * Every control here exists to fail on a specific mistake. A harness that cannot fail is
 * not evidence — a lesson this project has now paid for three times: M5's precache check
 * found zero entries and reported PASS, M6's two-query test could not distinguish its two
 * queries, and M7's UTF-8 zip control agreed with the very bug it existed to catch.
 */
function assert(ok, label, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`)
    return true
  }
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

/** Bit string to the run-length widths ZXing's reader actually matches on. */
function widthsOf(bits) {
  const widths = []
  let run = 1
  for (let i = 1; i < bits.length; i += 1) {
    if (bits[i] === bits[i - 1]) run += 1
    else {
      widths.push(run)
      run = 1
    }
  }
  widths.push(run)
  return widths
}

function selfTest() {
  let ok = true
  console.log('\nControls\n')

  // 1. The encoder's tables against the decoder's own, so a transcription slip cannot live.
  const zxingL = Array.from(EAN13Reader.L_PATTERNS ?? []).map((a) => Array.from(a))
  ok =
    assert(
      zxingL.length === 10,
      'ZXing L_PATTERNS reachable',
      `found ${zxingL.length} entries`,
    ) && ok
  for (let d = 0; d < 10; d += 1) {
    const mine = widthsOf(L_PATTERNS[d])
    const theirs = zxingL[d] ?? []
    ok =
      assert(
        JSON.stringify(mine) === JSON.stringify(theirs),
        `L pattern ${d} matches ZXing widths`,
        `${JSON.stringify(mine)} vs ${JSON.stringify(theirs)}`,
      ) && ok
  }

  // 2. The parity table against FIRST_DIGIT_ENCODINGS, the one that silently changes the number.
  const encodings = Array.from(EAN13Reader.FIRST_DIGIT_ENCODINGS ?? [])
  for (let d = 0; d < 10; d += 1) {
    const bitField = [...FIRST_DIGIT_PARITY[d]].reduce(
      (acc, ch) => (acc << 1) | (ch === 'G' ? 1 : 0),
      0,
    )
    ok =
      assert(
        bitField === encodings[d],
        `first-digit parity ${d} matches ZXing`,
        `0x${bitField.toString(16)} vs 0x${(encodings[d] ?? -1).toString(16)}`,
      ) && ok
  }

  // 3. Round trip. An encoder wrong in the parity table draws a plausible barcode that
  //    decodes to a DIFFERENT number, so this asserts equality, never "something decoded".
  for (const isbn of SAMPLE_ISBNS) {
    const bits = encodeEan13(isbn)
    const { buf } = renderScene(bits, { frameW: 1280, frameH: 400, barcodeFrac: 0.7 })
    const { text } = attemptDecode(buf, 1280, 400, { tryHarder: false })
    ok = assert(text === isbn, `round trip ${isbn}`, `decoded ${text ?? 'nothing'}`) && ok
  }

  // 3b. Every first digit, which real ISBNs cannot give us.
  //
  //     The plan expected the sample ISBNs to "span several different first digits" and
  //     they cannot: Bookland is 978/979, so every real book barcode starts with 9 and the
  //     loop above exercises exactly ONE of the ten parity words. That was proven the
  //     uncomfortable way — mutating `FIRST_DIGIT_PARITY[1]` left every round trip above
  //     passing, and only the table comparison caught it. These synthetic EAN-13s are not
  //     ISBNs and never will be scanned; they exist so a parity slip fails end-to-end here
  //     too, rather than resting on the table comparison alone.
  for (let first = 0; first <= 9; first += 1) {
    const body = `${first}12345678901`.slice(0, 12)
    const code = body + checkDigit(body)
    const bits = encodeEan13(code)
    const { buf } = renderScene(bits, { frameW: 1280, frameH: 400, barcodeFrac: 0.7 })
    const { text } = attemptDecode(buf, 1280, 400, { tryHarder: false })
    ok =
      assert(text === code, `round trip first digit ${first} (${code})`, `decoded ${text ?? 'nothing'}`) &&
      ok
  }

  // 4. Check digit, against the same weighting src/lib/isbn.ts applies.
  for (const isbn of SAMPLE_ISBNS) {
    ok =
      assert(
        checkDigit(isbn.slice(0, 12)) === Number(isbn[12]),
        `check digit ${isbn}`,
        'sample ISBN is not self-consistent',
      ) && ok
  }

  // 5. Blank frame decodes nothing, under both configs.
  for (const config of CONFIGS) {
    const blank = new Uint8ClampedArray(640 * 480).fill(255)
    const { text } = attemptDecode(blank, 640, 480, config)
    ok = assert(text === null, `blank frame decodes nothing (${config.label})`, `got ${text}`) && ok
  }

  // 6. A wrong check digit must be refused. Proves the pipeline validates rather than
  //    just reading bars — without it, a corrupt render could still "pass" the round trip.
  const bad = SAMPLE_ISBNS[0].slice(0, 12) + ((Number(SAMPLE_ISBNS[0][12]) + 1) % 10)
  const badBits = encodeEan13(bad)
  const { buf: badBuf } = renderScene(badBits, { frameW: 1280, frameH: 400, barcodeFrac: 0.7 })
  const badResult = attemptDecode(badBuf, 1280, 400, { tryHarder: false })
  ok = assert(badResult.text === null, 'wrong check digit is refused', `got ${badResult.text}`) && ok

  // 7. Monotonicity. If every cell reads 100% the degradations are not biting and the
  //    whole matrix is meaningless — this is the control on the *experiment*, not the code.
  const easy = runCell(RESOLUTIONS[2], DISTANCES[0], CONDITIONS[0], CONFIGS[0], 4)
  const hard = runCell(RESOLUTIONS[0], DISTANCES[2], CONDITIONS[1], CONFIGS[0], 4)
  ok =
    assert(
      easy.rate > hard.rate,
      'decode rate falls as conditions worsen',
      `easy ${easy.rate} vs hard ${hard.rate}`,
    ) && ok

  // 7b. Resolution must not run backwards, which is the failure this harness actually hit.
  //
  //     The first version applied blur and noise in fixed *pixels* at each stream size,
  //     which quietly modelled a different lens per resolution — and reported 1280 decoding
  //     0% of a condition that 640 decoded 100% of. Sampling one degraded scene at each
  //     resolution is the fix; this asserts the fix holds. Sampling more finely can tie,
  //     never lose.
  //
  //     **`dim + grain` is deliberately NOT in this loop, and adding it would be wrong.**
  //     Once per-pixel sensor noise is present, more pixels genuinely *do* decode worse,
  //     and that is a property of `HybridBinarizer` rather than a bug here: it thresholds
  //     on 8×8 blocks, so at 12 px/module a block sits entirely inside one bar with almost
  //     no dynamic range and falls back to its neighbourhood, while at 4 px/module the same
  //     block spans two modules and thresholds cleanly. Verified by isolating the two
  //     halves of the condition — contrast alone decodes 100% at every resolution; adding
  //     grain takes 1280 and 1920 to 0% while 640 stays at 100%. It is the reason this
  //     session shipped no resolution change.
  for (const condition of [CONDITIONS[0], CONDITIONS[1]]) {
    const low = runCell(RESOLUTIONS[0], DISTANCES[2], condition, CONFIGS[0], 4)
    const high = runCell(RESOLUTIONS[2], DISTANCES[2], condition, CONFIGS[0], 4)
    ok =
      assert(
        high.rate >= low.rate,
        `more pixels never decode worse (${condition.label})`,
        `640 ${low.rate} vs 1920 ${high.rate}`,
      ) && ok
  }

  // 8. The rotation subclass actually rotates, or TRY_HARDER's 90° retry is untested.
  const probe = new RotatableLuminanceSource(new Uint8ClampedArray([1, 2, 3, 4]), 2, 2)
  const rotated = probe.rotateCounterClockwise()
  ok =
    assert(
      probe.isRotateSupported() && Array.from(rotated._gray).join(',') === '2,4,1,3',
      'luminance source rotates counter-clockwise',
      Array.from(rotated._gray).join(','),
    ) && ok

  console.log(ok ? '\nAll controls passed.\n' : '\nCONTROLS FAILED.\n')
  return ok
}

// ---------------------------------------------------------------------------------------

const args = process.argv.slice(2)
if (args.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1)
} else {
  const trialsFlag = args.indexOf('--trials')
  const trials = trialsFlag === -1 ? 4 : Number(args[trialsFlag + 1]) || 4
  runMatrix(trials)
}
