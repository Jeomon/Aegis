/**
 * Layer 2, projected onto the screen.
 *
 * An identifier printed into the page — "Your Aadhaar is 2345 6789 0124" in a paragraph —
 * belongs to no field, so layer 1 never sees it, and it appears in no element's accessible
 * name, so the tree never carries it. It is visible in exactly one place: the screenshot.
 *
 * So the same detectors run over the page's text nodes, and each match is measured with a
 * Range. `getClientRects()` returns CSS pixels relative to the viewport, which is the same
 * origin `captureVisibleTab` uses — the two need no scroll offset between them, and adding
 * one would be the classic way to paint masks in the wrong place.
 *
 * A match can wrap across lines, which is why a Range yields *rects* rather than a rect.
 * Each fragment is masked separately; a single bounding box over a wrapped match would
 * cover the whole paragraph width between them.
 */

import { findPii } from '../shared/detect'
import type { Bounds } from '../shared/types'

/** Nothing inside these carries rendered text worth measuring. */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'title'])

/**
 * Bounds on the work. A content-heavy page can hold tens of thousands of text nodes, and
 * this runs on every turn — latency is 15% of the rubric and the scan already walks the
 * DOM once.
 */
const MAX_NODES = 4000
const MAX_RECTS = 200

/** Ignore text scrolled well away from the capture; the screenshot only holds the viewport. */
const MARGIN = 100

function offScreen(rect: DOMRect): boolean {
  return (
    rect.bottom < -MARGIN ||
    rect.right < -MARGIN ||
    rect.top > window.innerHeight + MARGIN ||
    rect.left > window.innerWidth + MARGIN
  )
}

function toBounds(rect: DOMRect): Bounds {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    documentX: rect.x + window.scrollX,
    documentY: rect.y + window.scrollY,
  }
}

/**
 * Every region of rendered text that layer 2 recognises as an identifier.
 *
 * Returns geometry only. The values themselves are not collected: nothing downstream shows
 * them, and reading a secret into a structure that outlives the paint would give it a
 * second life for no benefit.
 */
/**
 * Every text node under a root, descending through open shadow roots.
 *
 * A component that renders its content into a shadow root is on screen like anything else,
 * so a walker stopping at the shadow boundary leaves that text visible in the capture and
 * unmasked. scan.ts already crosses the boundary for elements; this crosses it for text.
 *
 * Closed roots stay unreachable, which is a limitation of the platform rather than of this
 * walk — nothing in the page can read them either.
 */
function* eachTextNode(root: Node): Generator<Text> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      yield node as Text
      continue
    }
    const shadow = (node as Element).shadowRoot
    if (shadow) yield* eachTextNode(shadow)
  }
}

export function piiTextRegions(): Bounds[] {
  const regions: Bounds[] = []

  let visited = 0
  for (const node of eachTextNode(document.body)) {
    if (++visited > MAX_NODES || regions.length >= MAX_RECTS) break

    const parent = node.parentElement
    if (!parent || SKIP_TAGS.has(parent.tagName.toLowerCase())) continue
    // Short runs cannot hold any identifier we look for; the shortest is a ten-digit phone.
    if (!node.nodeValue || node.nodeValue.trim().length < 10) continue

    const text = node.nodeValue
    const matches = findPii(text)
    if (!matches.length) continue

    for (const match of matches) {
      const range = document.createRange()
      range.setStart(node, match.start)
      range.setEnd(node, match.end)

      for (const rect of range.getClientRects()) {
        // A zero-area rect is a collapsed or undisplayed fragment, not something on screen.
        if (rect.width <= 0 || rect.height <= 0) continue
        if (offScreen(rect)) continue
        regions.push(toBounds(rect))
        if (regions.length >= MAX_RECTS) break
      }

      range.detach()
      if (regions.length >= MAX_RECTS) break
    }
  }

  return regions
}
