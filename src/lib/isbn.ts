/**
 * ISBN-13 validation (SPEC §9).
 *
 * Book barcodes are EAN-13 in the Bookland range — thirteen digits beginning 978 or 979.
 * The scanner decodes continuously and misreads are routine, so every candidate is
 * checked here before it is allowed to cost a network round trip. A product barcode on
 * the back of a paperback, a library sticker, or a half-read label all stop in this file
 * rather than four to ten seconds later in Open Library.
 */

/** Strips the separators printed ISBNs carry. Nothing else is removed. */
export function normalizeIsbn13(value: string): string {
  return value.replace(/[\s-]/g, '')
}

/**
 * EAN-13's check digit: the first twelve digits weighted 1, 3, 1, 3 … and summed, with
 * the check digit being whatever brings that total to a multiple of ten.
 *
 * **Known blind spot, and it belongs to the format rather than to this function.**
 * Swapping two *adjacent* digits changes the weighted sum by `2(a − b)`, which vanishes
 * mod 10 whenever the pair differs by exactly 5 — or is equal, which swaps to the same
 * string. Those transpositions are undetectable by any correct implementation of this
 * checksum. Don't try to catch them here.
 */
export function isValidIsbn13(value: string): boolean {
  const digits = normalizeIsbn13(value)

  if (!/^\d{13}$/.test(digits)) return false

  // The Bookland prefixes. An EAN-13 carrying any other prefix is a genuine barcode for
  // something that is not a book, and the lookup would spend the round trip to say so.
  if (!digits.startsWith('978') && !digits.startsWith('979')) return false

  let sum = 0
  for (let i = 0; i < 12; i += 1) {
    sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3)
  }

  return (10 - (sum % 10)) % 10 === Number(digits[12])
}
