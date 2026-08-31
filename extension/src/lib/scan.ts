/**
 * Interactive-element detection, ported from the browser_use DOM service.
 *
 * The pipeline mirrors the original: collect candidates in document order, keep the ones
 * that look operable, drop those an interactive ancestor already names, drop those that
 * are actually covered on screen, then collapse stacked wrapper/inner pairs.
 *
 * Two stages are better here than over CDP. The occlusion check compares node identity
 * instead of matching tag plus top-left within 4px, because we hold the real element
 * reference; and shadow roots are walked directly rather than pierced from injected JS.
 */

import { accessibleName, displayRole, hasWidgetStateAttributes, interactiveStates, isFocusable } from './accname'
import {
  EXCLUDED_TAGS,
  INTERACTIVE_ROLES,
  INTERACTIVE_TAGS,
  STRONG_INTERACTIVE_TAGS,
  hasSearchIndicator,
  roleOf,
} from './roles'
import type { Bounds, InteractiveElement, ScanCounts } from '../types'

/**
 * Stable ids for the lifetime of the page. CDP hands out backendNodeIds; we mint our own,
 * in a WeakMap rather than a data-attribute so the page is never mutated. An element that
 * survives a rescan keeps its id, so ids only churn when the page itself changes.
 */
const ids = new WeakMap<Element, number>()
let nextId = 1

/**
 * Reverse lookup for actions, rebuilt on every scan. Actions arrive after the scan has
 * returned, so this has to be module state rather than something handed to the caller.
 * Replacing it per scan bounds what we hold on to, and matches browser_use's rule that
 * ids are only valid against the latest observation.
 */
const registry = new Map<number, Element>()

function idOf(el: Element): number {
  let id = ids.get(el)
  if (id === undefined) {
    id = nextId++
    ids.set(el, id)
  }
  return id
}

/** The element behind a scan id, or null if it is stale or was never scanned. */
export function resolveElement(id: number): Element | null {
  const el = registry.get(id)
  if (!el) return null
  // Detached between the scan and the action: treat as stale rather than acting on nothing.
  return el.isConnected ? el : null
}

/** Parent element, crossing an open shadow boundary via the host. */
export function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement
  const root = el.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

/** elementFromPoint that descends through open shadow roots. */
function deepElementFromPoint(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y)
  while (el?.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y)
    if (!inner || inner === el) break
    el = inner
  }
  return el
}

/** Document-order walk of the element tree, descending into open shadow roots. */
function* walk(root: Element | ShadowRoot | Document): Generator<Element> {
  for (const child of root.children) {
    const tag = child.tagName.toLowerCase()
    if (EXCLUDED_TAGS.has(tag)) continue

    yield child
    if (child.shadowRoot) yield* walk(child.shadowRoot)
    yield* walk(child)
  }
}

function boundsOf(rect: DOMRect): Bounds {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    documentX: rect.left + window.scrollX,
    documentY: rect.top + window.scrollY,
  }
}

/** Below this, an element is decoration rather than a control. Matches browser_use. */
const MIN_SIZE = 10

/**
 * Elements this far outside the viewport are still reported. An agent benefits from
 * knowing about a control just past the fold, and the bounds stay truthful.
 */
const VIEWPORT_MARGIN = 200

function nearViewport(rect: DOMRect, position: string): boolean {
  if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return false
  // A fixed or sticky element is pinned to the viewport wherever the page is scrolled.
  if (position === 'fixed' || position === 'sticky') return true
  return (
    rect.bottom > -VIEWPORT_MARGIN &&
    rect.right > -VIEWPORT_MARGIN &&
    rect.top < window.innerHeight + VIEWPORT_MARGIN &&
    rect.left < window.innerWidth + VIEWPORT_MARGIN
  )
}

/**
 * Opacity as it actually renders, multiplied down the ancestor chain.
 *
 * CSS opacity is not inherited in computed style — every node reports its own — but the
 * visual result compounds. A link at opacity 1 inside a container at opacity 0 is
 * invisible, passes an own-opacity check, and stays hit-testable so the occlusion filter
 * keeps it too. This is how hidden dropdowns and flyouts leak into the observation.
 */
const opacityCache = new Map<Element, number>()

function effectiveOpacity(el: Element): number {
  const cached = opacityCache.get(el)
  if (cached !== undefined) return cached

  const own = Number(getComputedStyle(el).opacity)
  const parent = parentOf(el)
  const value = (Number.isFinite(own) ? own : 1) * (parent ? effectiveOpacity(parent) : 1)

  opacityCache.set(el, value)
  return value
}

function isScrollable(el: Element, style: CSSStyleDeclaration): boolean {
  const overflow = style.overflowY
  return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 1
}

/**
 * Does this element look operable? Mirrors the original predicate, minus CDP's isClickable
 * hint which has no browser-side equivalent — cursor:pointer and onclick recover most of it.
 */
function isInteractive(el: Element, style: CSSStyleDeclaration, role: string): boolean {
  const tag = el.tagName.toLowerCase()
  return (
    INTERACTIVE_TAGS.has(tag) ||
    INTERACTIVE_ROLES.has(role) ||
    style.cursor === 'pointer' ||
    isFocusable(el) ||
    (el instanceof HTMLElement && el.isContentEditable) ||
    hasWidgetStateAttributes(el) ||
    el.hasAttribute('onclick') ||
    el.hasAttribute('href') ||
    hasSearchIndicator(el)
  )
}

/**
 * A strong signal is a real interactive tag or role, an href, an onclick, or
 * contenteditable — as opposed to a weak one (inherited cursor:pointer, a bare tabindex)
 * that layout containers pick up incidentally.
 */
function isStrongSignal(el: Element, role: string): boolean {
  const tag = el.tagName.toLowerCase()
  return (
    INTERACTIVE_TAGS.has(tag) ||
    INTERACTIVE_ROLES.has(role) ||
    el.hasAttribute('href') ||
    el.hasAttribute('onclick') ||
    ['true', '', 'plaintext-only'].includes(el.getAttribute('contenteditable') ?? 'absent')
  )
}

/** Interactive in its own right — the narrower test used when collapsing nested pairs. */
function isStrongElement(el: Element, role: string): boolean {
  const tag = el.tagName.toLowerCase()
  return (
    STRONG_INTERACTIVE_TAGS.has(tag) ||
    INTERACTIVE_ROLES.has(role) ||
    el.hasAttribute('href') ||
    el.hasAttribute('onclick') ||
    ['true', '', 'plaintext-only'].includes(el.getAttribute('contenteditable') ?? 'absent')
  )
}

/** A control a click bubbles up to, making a weak descendant redundant. */
function isLinkOrButton(el: Element, role: string): boolean {
  const tag = el.tagName.toLowerCase()
  return (
    tag === 'a' ||
    tag === 'button' ||
    el.hasAttribute('href') ||
    el.hasAttribute('onclick') ||
    role === 'link' ||
    role === 'button'
  )
}

interface Candidate {
  el: Element
  role: string
  name: string
  strong: boolean
  rect: DOMRect
  style: CSSStyleDeclaration
}

export interface ScanOutput {
  elements: InteractiveElement[]
  kept: Map<number, Element>
  counts: ScanCounts
}

export function scanInteractive(): ScanOutput {
  const counts: ScanCounts = {
    visited: 0,
    interactive: 0,
    afterNameDedup: 0,
    afterOcclusion: 0,
    final: 0,
  }

  // Computed styles change between scans, so the memo cannot outlive one pass.
  opacityCache.clear()
  // ---- 1. collect candidates in document order -----------------------------------
  const candidates: Candidate[] = []
  // Name and strength of every kept ancestor, for the dominance test below.
  const kept = new Map<Element, { name: string; strong: boolean }>()

  for (const el of walk(document)) {
    counts.visited++

    if (el.getAttribute('aria-hidden') === 'true') continue

    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)

    if (style.display === 'none' || style.visibility === 'hidden') continue
    if (!nearViewport(rect, style.position)) continue
    // Multiplied down the ancestor chain, so a hidden flyout's children go with it.
    if (effectiveOpacity(el) <= 0.01) continue

    const role = roleOf(el)
    if (!isInteractive(el, style, role)) continue
    counts.interactive++

    const strong = isStrongSignal(el, role)
    const name = accessibleName(el)

    // No accessible name: keep only icon-only real controls, drop layout noise.
    if (!name && !strong) continue

    // Name dominance: an interactive ancestor already carrying this name wins, unless it
    // is merely weak and this element is a real control — otherwise a role=search wrapper
    // would swallow the actual Search button it is named after.
    if (name) {
      let dominated = false
      for (let cur = parentOf(el); cur; cur = parentOf(cur)) {
        const ancestor = kept.get(cur)
        if (ancestor?.name === name && (ancestor.strong || !strong)) {
          dominated = true
          break
        }
      }
      if (dominated) continue
      kept.set(el, { name, strong })
    }

    candidates.push({ el, role, name, strong, rect, style })
  }
  counts.afterNameDedup = candidates.length

  // ---- 2. occlusion: drop anything actually covered on screen ---------------------
  const visible = candidates.filter(({ el, rect }) => {
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2

    // Elements just past the fold are reported but cannot be hit-tested — nothing is
    // painted there. Clamping the point would test some unrelated element instead.
    const onScreen = cx >= 0 && cx < window.innerWidth && cy >= 0 && cy < window.innerHeight
    if (!onScreen) return true

    for (let hit = deepElementFromPoint(cx, cy); hit; hit = parentOf(hit)) {
      if (hit === el) return true
    }
    return false
  })
  counts.afterOcclusion = visible.length

  // ---- 3. collapse stacked wrapper/inner duplicates -------------------------------
  const surviving = new Set(visible.map((c) => c.el))
  const byElement = new Map(visible.map((c) => [c.el, c]))

  // Must skip elements already dropped in this pass and keep climbing. Resolving against
  // the pre-drop set instead lets a candidate escape collapse entirely when its nearest
  // ancestor is removed first — that is what leaves a stray <span> under a link.
  const nearestKept = (el: Element, dropped: ReadonlySet<Element>): Element | null => {
    for (let cur = parentOf(el); cur; cur = parentOf(cur)) {
      if (surviving.has(cur) && !dropped.has(cur)) return cur
    }
    return null
  }

  const fractionContained = (outer: DOMRect, inner: DOMRect): number => {
    const x0 = Math.max(outer.left, inner.left)
    const y0 = Math.max(outer.top, inner.top)
    const x1 = Math.min(outer.right, inner.right)
    const y1 = Math.min(outer.bottom, inner.bottom)
    const overlap = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
    const area = inner.width * inner.height
    return area ? overlap / area : 0
  }

  const dropped = new Set<Element>()
  for (const candidate of visible) {
    if (dropped.has(candidate.el)) continue

    const ancestorEl = nearestKept(candidate.el, dropped)
    if (!ancestorEl) continue
    const ancestor = byElement.get(ancestorEl)
    if (!ancestor) continue

    const innerStrong = isStrongElement(candidate.el, candidate.role)
    const outerStrong = isStrongElement(ancestorEl, ancestor.role)

    // A weak piece inside a genuine link/button is redundant: clicking it activates the
    // ancestor anyway. This folds a result card's title and spans into the one link.
    if (!innerStrong && isLinkOrButton(ancestorEl, ancestor.role)) {
      dropped.add(candidate.el)
      continue
    }

    if (fractionContained(ancestor.rect, candidate.rect) < 0.9) continue

    if (outerStrong && !innerStrong) dropped.add(candidate.el)
    else if (innerStrong && !outerStrong) dropped.add(ancestorEl)
    else if (!innerStrong && !outerStrong) dropped.add(ancestorEl)
    // both strong: two genuinely distinct controls, keep both
  }

  const final = visible.filter((c) => !dropped.has(c.el))
  counts.final = final.length

  // Ids from the previous scan stop being addressable here, deliberately.
  registry.clear()
  const elementsById = new Map<number, Element>()
  const elements = final.map(({ el, role, name, strong, rect, style }) => {
    const id = idOf(el)
    elementsById.set(id, el)
    registry.set(id, el)
    return {
      id,
      tag: el.tagName.toLowerCase(),
      role: role || displayRole(el),
      name,
      states: interactiveStates(el),
      bounds: boundsOf(rect),
      strong,
      scrollable: isScrollable(el, style),
      shadow: el.getRootNode() instanceof ShadowRoot,
    } satisfies InteractiveElement
  })

  return { elements, kept: elementsById, counts }
}
