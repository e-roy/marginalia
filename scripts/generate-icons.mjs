/**
 * Generates the PWA icon set with zero dependencies — Node's zlib writes the PNGs.
 *
 * The mark: a margin rule with note lines beside it. Ink ground, oxidized-brown rule,
 * paper-coloured notes — the same iron-gall palette the app and the spec document use.
 *
 * Run: node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const INK = [0x1c, 0x25, 0x36]
const PAPER = [0xef, 0xed, 0xe7]
const OXIDE = [0x8a, 0x5a, 0x2b]

// ── PNG encoding ────────────────────────────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  // One filter byte (0 = None) per scanline, then the row's pixels.
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Drawing ─────────────────────────────────────────────────────────────────
/** Signed distance from a point to a rounded rectangle; negative means inside. */
function roundRectDistance(px, py, x, y, w, h, r) {
  const cx = Math.abs(px - (x + w / 2)) - (w / 2 - r)
  const cy = Math.abs(py - (y + h / 2)) - (h / 2 - r)
  const dx = Math.max(cx, 0)
  const dy = Math.max(cy, 0)
  return Math.min(Math.max(cx, cy), 0) + Math.sqrt(dx * dx + dy * dy) - r
}

function drawIcon(size, inset) {
  const rgba = Buffer.alloc(size * size * 4)
  const content = size * (1 - inset * 2)
  const ox = size * inset
  const oy = size * inset

  const ruleX = ox + content * 0.215
  const ruleW = Math.max(2, content * 0.05)
  const lineX = ruleX + content * 0.155
  const lineH = content * 0.076
  const lines = [
    { y: oy + content * 0.265, w: content * 0.6 },
    { y: oy + content * 0.462, w: content * 0.48 },
    { y: oy + content * 0.659, w: content * 0.33 },
  ]

  const SS = 3 // 3x3 supersampling for clean edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS

          let colour = INK
          if (
            roundRectDistance(
              px,
              py,
              ruleX,
              oy + content * 0.1,
              ruleW,
              content * 0.8,
              ruleW / 2,
            ) <= 0
          ) {
            colour = OXIDE
          } else {
            for (const line of lines) {
              if (
                roundRectDistance(px, py, lineX, line.y, line.w, lineH, lineH / 2) <= 0
              ) {
                colour = PAPER
                break
              }
            }
          }
          r += colour[0]
          g += colour[1]
          b += colour[2]
        }
      }
      const n = SS * SS
      const i = (y * size + x) * 4
      rgba[i] = Math.round(r / n)
      rgba[i + 1] = Math.round(g / n)
      rgba[i + 2] = Math.round(b / n)
      rgba[i + 3] = 255 // fully opaque — iOS renders transparent icons on black
    }
  }
  return encodePng(size, rgba)
}

// ── Emit ────────────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true })

const targets = [
  ['icon-192.png', 192, 0.13],
  ['icon-512.png', 512, 0.13],
  // Maskable icons get inset further so nothing important sits in the crop zone.
  ['icon-maskable-512.png', 512, 0.23],
  ['apple-touch-icon.png', 180, 0.13],
]

for (const [name, size, inset] of targets) {
  writeFileSync(join(OUT, name), drawIcon(size, inset))
  console.log(`  ${name}  ${size}x${size}`)
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#1C2536"/>
  <rect x="26.9" y="23" width="5" height="54" rx="2.5" fill="#8A5A2B"/>
  <rect x="38.4" y="30.9" width="40.5" height="5.1" rx="2.6" fill="#EFEDE7"/>
  <rect x="38.4" y="44.2" width="32.4" height="5.1" rx="2.6" fill="#EFEDE7"/>
  <rect x="38.4" y="57.5" width="22.3" height="5.1" rx="2.6" fill="#EFEDE7"/>
</svg>
`
writeFileSync(join(OUT, 'favicon.svg'), svg)
console.log('  favicon.svg')
