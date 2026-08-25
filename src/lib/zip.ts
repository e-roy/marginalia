/**
 * A store-only ZIP writer, for "Export all" (`SPEC §11`).
 *
 * **Hand-rolled rather than a dependency**, following `scripts/generate-icons.mjs`'s
 * precedent — the entries are Markdown text, so compression would save kilobytes on a
 * file measured in kilobytes, and method 0 removes the only part that would have needed a
 * library. Unlike ADR-015's 125 kB barcode decoder this is about 2 kB, so it is a plain
 * static import rather than a lazy chunk: the machinery of splitting it out would cost
 * more than the bytes it saved.
 *
 * **It imports nothing**, deliberately, so `node --experimental-strip-types` can run it
 * and the output can be extracted by a real unzipper. A byte format is not something to
 * verify by reading — the first draft of this file had a 0-based DOS month, and every
 * filename survived, every file was byte-identical, and every entry silently landed dated
 * 1980-01-01.
 *
 * Layout (all multi-byte fields little-endian):
 *
 *   local file header      30 + name    sig 0x04034b50
 *   central directory      46 + name    sig 0x02014b50, local-header offset at byte 42
 *   end of central dir     22           sig 0x06054b50, entry count written twice
 *
 * ZIP64 is not implemented and is not needed: these archives are Markdown text and cannot
 * approach the 4 GB ceiling the 32-bit size fields impose.
 */

export interface ZipEntry {
  /** Already sanitized and collision-resolved — see `markdown.ts`. */
  name: string
  bytes: Uint8Array
}

/** Flag bit 11. Without it a name with a curly apostrophe extracts mangled. */
const UTF8_FLAG = 0x0800

const STORED = 0

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * MS-DOS date and time, which is what ZIP has instead of a timestamp.
 *
 * **`month` and `day` are 1-based**, so `getMonth() + 1` — `getMonth()` is 0-based and the
 * mistake is invisible in every other assertion you would think to write. Seconds have
 * one-bit resolution, hence `>> 1`; that is the format, not a rounding choice.
 */
function dosDateTime(when: Date): { time: number; date: number } {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  }
}

/** A little cursor, so the record layouts below read as their field tables. */
class Writer {
  private readonly view: DataView
  private readonly bytes: Uint8Array<ArrayBuffer>
  private at = 0

  constructor(size: number) {
    this.bytes = new Uint8Array(size)
    this.view = new DataView(this.bytes.buffer)
  }

  u16(value: number) {
    this.view.setUint16(this.at, value, true)
    this.at += 2
  }

  u32(value: number) {
    this.view.setUint32(this.at, value >>> 0, true)
    this.at += 4
  }

  raw(value: Uint8Array) {
    this.bytes.set(value, this.at)
    this.at += value.length
  }

  get offset() {
    return this.at
  }

  get result() {
    return this.bytes
  }
}

export function zipStore(entries: ZipEntry[], when: Date): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(when)

  // Encoded once: the length fields count BYTES, not characters, and re-encoding for the
  // central directory would be a second chance to disagree with the local header.
  const prepared = entries.map((entry) => ({
    name: encoder.encode(entry.name),
    bytes: entry.bytes,
    crc: crc32(entry.bytes),
    offset: 0,
  }))

  const localSize = prepared.reduce((sum, e) => sum + 30 + e.name.length + e.bytes.length, 0)
  const centralSize = prepared.reduce((sum, e) => sum + 46 + e.name.length, 0)

  const writer = new Writer(localSize + centralSize + 22)

  for (const entry of prepared) {
    entry.offset = writer.offset
    writer.u32(0x04034b50)
    writer.u16(20) // version needed to extract
    writer.u16(UTF8_FLAG)
    writer.u16(STORED)
    writer.u16(time)
    writer.u16(date)
    writer.u32(entry.crc)
    writer.u32(entry.bytes.length) // compressed — identical, since nothing is compressed
    writer.u32(entry.bytes.length)
    writer.u16(entry.name.length)
    writer.u16(0) // extra field length
    writer.raw(entry.name)
    writer.raw(entry.bytes)
  }

  const centralStart = writer.offset

  for (const entry of prepared) {
    writer.u32(0x02014b50)
    writer.u16(20) // version made by
    writer.u16(20) // version needed to extract
    writer.u16(UTF8_FLAG)
    writer.u16(STORED)
    writer.u16(time)
    writer.u16(date)
    writer.u32(entry.crc)
    writer.u32(entry.bytes.length)
    writer.u32(entry.bytes.length)
    writer.u16(entry.name.length)
    writer.u16(0) // extra field length
    writer.u16(0) // file comment length
    writer.u16(0) // disk number start
    writer.u16(0) // internal attributes
    writer.u32(0) // external attributes
    writer.u32(entry.offset)
    writer.raw(entry.name)
  }

  writer.u32(0x06054b50)
  writer.u16(0) // this disk
  writer.u16(0) // disk holding the central directory
  writer.u16(prepared.length) // entries on this disk
  writer.u16(prepared.length) // entries total — the same number, twice, by the format
  // The size computed up front rather than derived from the cursor. Deriving it means
  // subtracting however many bytes of this record have already been written, which is a
  // constant nobody can check by reading — and the first draft had it wrong by 4.
  writer.u32(centralSize)
  writer.u32(centralStart)
  writer.u16(0) // archive comment length

  return writer.result
}
