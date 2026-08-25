/**
 * Hand a Blob to the browser as a file.
 *
 * The whole export path is client-side (`SPEC §11`) — no function, no Storage, no cost —
 * so this anchor is the only thing standing between a generated string and the user's
 * disk.
 */

/**
 * How long to keep the object URL alive after the click.
 *
 * Not `revokeObjectURL` on the next tick, which is the common shortcut: Safari has been
 * observed cancelling a download whose URL was revoked before it had finished reading it,
 * and iOS Safari is this app's primary target. Ten seconds is far longer than a
 * kilobyte-scale file needs and short enough that nothing meaningful is held.
 */
const REVOKE_DELAY_MS = 10_000

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'

  // Appended before clicking because Firefox ignores a click on a detached anchor.
  document.body.append(link)
  link.click()
  link.remove()

  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}
