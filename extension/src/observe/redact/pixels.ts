/**
 * The pixel half of the cascade: paint out what layers 1 and 2 identified.
 *
 * This module decides *what* is covered and paints it. It deliberately does not own the
 * capture or the labelling, so the privacy step can be read and tested on its own rather
 * than being buried inside a function called "annotate".
 *
 * Two rules from the design that are easy to get wrong:
 *
 * Solid, never blurred. Blur is reversible under super-resolution, and a blurred password
 * that can be recovered is worse than an unblurred one, because it looks handled. The
 * problem statement itself says "blurring faces", so painting opaque and saying why is
 * free marks on redaction precision.
 *
 * Dilated. Anti-aliased glyph edges bleed outside their box and stay legible — and
 * recoverable — if the mask is drawn tight to the measured rectangle.
 */

import type { Bounds, InteractiveElement } from '../../shared/types'

/**
 * Grow every mask by this many pixels on all sides, in the drawn image's own space.
 *
 * Three rather than one because the capture is downscaled from device pixels before this
 * runs, so a fringe that was two device pixels wide is still present, merely smaller.
 */
export const DILATION = 3

/** Opaque. The colour matters only in that it must not be semi-transparent. */
const MASK_FILL = '#000000'

/**
 * Which regions to cover.
 *
 * A field is masked when it was classified sensitive *and* actually holds something. An
 * empty password box has nothing to hide, and covering it would both cost precision and
 * destroy the one signal the agent has in screenshot-only mode — whether the field still
 * needs filling.
 */
export function sensitiveRegions(elements: readonly InteractiveElement[]): Bounds[] {
  return elements
    .filter((el) => el.sensitive && el.states.some((state) => state.startsWith('value=')))
    .map((el) => el.bounds)
}

/**
 * Paint the regions out.
 *
 * `factor` converts CSS pixels to the drawn image's coordinates — the same conversion the
 * labels use, so a mask and its `[id]` box can never disagree about where an element is.
 * Returns how many regions were actually painted, which the caller reports rather than
 * asserting that redaction happened.
 */
export function maskRegions(
  ctx: OffscreenCanvasRenderingContext2D,
  regions: readonly Bounds[],
  factor: number,
  width: number,
  height: number,
): number {
  ctx.save()
  ctx.fillStyle = MASK_FILL

  let painted = 0
  for (const region of regions) {
    const left = region.x * factor - DILATION
    const top = region.y * factor - DILATION
    const right = (region.x + region.width) * factor + DILATION
    const bottom = (region.y + region.height) * factor + DILATION

    // Clamp to the image. A field scrolled half out of view still has the visible half
    // covered; one entirely outside contributes nothing.
    const x0 = Math.max(0, Math.floor(left))
    const y0 = Math.max(0, Math.floor(top))
    const x1 = Math.min(width, Math.ceil(right))
    const y1 = Math.min(height, Math.ceil(bottom))
    if (x1 <= x0 || y1 <= y0) continue

    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    painted++
  }

  ctx.restore()
  return painted
}
