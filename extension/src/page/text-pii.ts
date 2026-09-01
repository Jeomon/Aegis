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

import { findNerPiiBatch } from '../shared/ner'
import type { Match } from '../shared/detect'

/**
 * Interface chrome, as opposed to content.
 *
 * The cascade's rule is that a model runs only where the cheap layers could not explain
 * what it is looking at, and for text that means page content rather than the controls
 * around it. A field's own label is the case that matters: "CVV" inside a <label> is
 * already classified structurally by layer 1, and handing it to an NER is precisely how it
 * comes back tagged as an organisation.
 *
 * This tests what the node *is* rather than how long it is. A word-count threshold looked
 * equivalent and was not — a name usually sits in its own <span>, so "Ravi Menon" is two
 * words and would have been skipped, which is the one thing the model exists to catch.
 */
const CHROME_SELECTOR = 'label, button, option, select, th, summary, [role="button"], [role="tab"]'

function isInterfaceChrome(node: Text): boolean {
  return node.parentElement?.closest(CHROME_SELECTOR) !== null
}

/**
 * Where identifiers are on screen, from both the rules and the model.
 *
 * One walk, one batch. The previous shape walked the DOM twice and ran the model over both
 * passes — the same nodes, classified twice, which was the bulk of a twelve-second scan.
 */
export async function piiTextRegions(): Promise<Bounds[]> {
  const regions: Bounds[] = []

  const nodes: Text[] = []
  const texts: string[] = []
  let visited = 0

  for (const node of eachTextNode(document.body)) {
    if (++visited > MAX_NODES) break

    const parent = node.parentElement
    if (!parent || SKIP_TAGS.has(parent.tagName.toLowerCase())) continue
    // Short runs cannot hold any identifier we look for; the shortest is a ten-digit phone.
    if (!node.nodeValue || node.nodeValue.trim().length < 10) continue

    nodes.push(node)
    texts.push(node.nodeValue)
  }

  // Only page content reaches the model; every node still goes through the rules.
  const proseIndexes = nodes.map((n, i) => (isInterfaceChrome(n) ? -1 : i)).filter((i) => i >= 0)
  const nerByIndex = new Map<number, Match[]>()

  if (proseIndexes.length) {
    const results = await findNerPiiBatch(proseIndexes.map((i) => texts[i]))
    proseIndexes.forEach((index, n) => nerByIndex.set(index, results[n] ?? []))
  }

  for (let i = 0; i < nodes.length; i++) {
    if (regions.length >= MAX_RECTS) break

    const text = texts[i]
    const matches = [...findPii(text), ...(nerByIndex.get(i) ?? [])]
    if (!matches.length) continue

    // Earliest start wins, longest on a tie: a GSTIN is not also reported as the PAN inside
    // it, and a name found by both engines is masked once.
    matches.sort((a, b) => a.start - b.start || b.end - a.end)
    let consumed = -1

    for (const match of matches) {
      if (match.start < consumed) continue
      consumed = match.end

      const range = document.createRange()
      range.setStart(nodes[i], match.start)
      range.setEnd(nodes[i], match.end)

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
