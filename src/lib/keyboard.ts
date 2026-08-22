/**
 * Keeps `--keyboard-inset` on the document element in step with the software keyboard.
 *
 * **iOS Safari does not shrink the layout viewport when the keyboard opens.** It leaves
 * layout alone and overlays the keyboard on top, shrinking only the *visual* viewport.
 * So a `position: fixed` element anchored to `bottom: 0` — every bottom sheet in this
 * app — ends up underneath the keyboard, and iOS cannot scroll it into view the way it
 * does for ordinary in-page inputs, because a fixed element does not scroll.
 *
 * `dvh` is not the answer either: it tracks the collapsing URL bar, not the keyboard.
 * The visual viewport is the only thing that knows, hence this.
 *
 * The variable is consumed in `src/index.css`, so no component has to think about it —
 * see the rule on `[data-slot='sheet-content'][data-side='bottom']`.
 */

const PROPERTY = '--keyboard-inset'


/**
 * Started once, for the life of the app. Returns a teardown so the effect that owns it
 * can unsubscribe, matching `initCapture`'s shape in `src/stores/capture.ts`.
 */
export function initKeyboardInset(): () => void {
  const viewport = window.visualViewport
  // Every browser this app targets has it, but a missing viewport must degrade to "no
  // keyboard" rather than throw — the fallback in the CSS is 0px.
  if (!viewport) return () => {}

  const update = () => {
    /**
     * What the keyboard covers is whatever sits below the visual viewport's bottom
     * edge. `offsetTop` matters because iOS scrolls the visual viewport up to reveal a
     * focused input, and without it the inset reads as zero mid-scroll and the sheet
     * drops behind the keyboard again.
     */
    const covered = window.innerHeight - (viewport.height + viewport.offsetTop)

    // Round, because the visual viewport reports fractional pixels mid-animation and a
    // custom property that changes every frame makes the sheet jitter. Small values are
    // clamped away: iOS reports a pixel or two of inset with no keyboard at all.
    const inset = covered > 1 ? Math.round(covered) : 0

    document.documentElement.style.setProperty(PROPERTY, `${inset}px`)
  }

  update()
  viewport.addEventListener('resize', update)
  viewport.addEventListener('scroll', update)

  return () => {
    viewport.removeEventListener('resize', update)
    viewport.removeEventListener('scroll', update)
    document.documentElement.style.removeProperty(PROPERTY)
  }
}
