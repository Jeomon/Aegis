/**
 * Reaching into frames.
 *
 * An embedded payment form is a cross-origin iframe, which is both where card numbers live
 * and where the agent most often needs to type. Neither the parent's DOM nor its JS can see
 * inside one: the element is opaque, while the screenshot renders its contents perfectly.
 *
 * The content script runs in every frame, so each can scan its own document. What a child
 * cannot discover is where it sits — `window.frameElement` throws across origins. So the
 * direction is inverted: the parent asks, the child answers in its own coordinates, and the
 * parent translates, because only the parent knows the iframe's position.
 *
 * Replies are matched to an iframe by `contentWindow === event.source`, which is permitted
 * across origins. Matching on URL would break the moment a page embeds the same form twice.
 *
 * Collisions are avoided rather than repaired. Each frame is handed an index and derives a
 * disjoint id block and handle namespace from it, so an action can be forwarded carrying
 * the id the model used, and no mapping table has to stay correct between turns.
 *
 * Nesting falls out of the recursion: a frame asked for its contents asks its own children
 * first, translating their coordinates into its own before answering.
 */

import { scanInteractive } from './scan'
import { classifySensitive } from './sensitive'
import { piiTextRegions } from './text-pii'
import { buildTree } from './tree'
import { handleTag, setFrameHandleTag } from './vault'
import { executePageAction } from './execute'
import type { ActionResult, PageAction } from '../shared/actions'
import type { Bounds, InteractiveElement, ScanCounts, TreeNode } from '../shared/types'

const SCAN_REQ = 'AEGIS_FRAME_SCAN_REQ'
const SCAN_RES = 'AEGIS_FRAME_SCAN_RES'
const ACT_REQ = 'AEGIS_FRAME_ACT_REQ'
const ACT_RES = 'AEGIS_FRAME_ACT_RES'

/** A frame that does not answer promptly is skipped; a turn must not stall on one. */
const SCAN_TIMEOUT_MS = 250
const ACT_TIMEOUT_MS = 5000

/**
 * Limits taken from browser_use's frame settings, which had to solve the same problem over
 * CDP. Depth stops a page nesting frames until the recursion costs more than the turn;
 * MIN_SIZE skips the 1×1 tracking and advertising frames that every commercial page carries
 * and that hold nothing anyone can interact with.
 */
const MAX_DEPTH = 5
const MAX_FRAMES = 100
const MIN_FRAME_SIZE = 50

/**
 * A page can impersonate a frame of ours, so a reply is treated as untrusted. Regions only
 * ever widen a mask and elements only ever add addressable targets, so the damage a hostile
 * reply can do is noise rather than exposure — but it is capped so a page cannot black out
 * the capture or flood the observation.
 */
const MAX_REGIONS_PER_FRAME = 60
const MAX_ELEMENTS_PER_FRAME = 60

interface FramePayload {
  elements: InteractiveElement[]
  roots: TreeNode[]
  regions: Bounds[]
  /** This frame's own scan counts. Children's are not merged; they describe another walk. */
  counts: ScanCounts
}

interface Envelope {
  __aegis: string
  nonce: string
  /** Inherited handle namespace, extended at each level so it is unique by path. */
  tag?: string
  depth?: number
  payload?: FramePayload
  action?: PageAction
  result?: ActionResult
}

function isEnvelope(data: unknown, kind: string): data is Envelope {
  const m = data as Envelope | null
  return !!m && m.__aegis === kind && typeof m.nonce === 'string'
}

const nonces = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

/**
 * Where an element id came from.
 *
 * Ids are handed out by whichever frame aggregates, not carved into fixed blocks per frame:
 * a block scheme has to encode the whole frame path to stay disjoint, and it silently
 * failed at depth two — a nested frame restarted its own child numbering and reused its
 * grandparent's block, so acting on one element operated on another.
 *
 * The child keeps its own numbering, so an action is translated back on the way in.
 */
const owners = new Map<number, { window: Window; localId: number }>()

export function frameOwnerOf(elementId: number): { window: Window; localId: number } | undefined {
  return owners.get(elementId)
}

// ---------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------

function bounds(rect: DOMRect): Bounds {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    documentX: rect.x + window.scrollX,
    documentY: rect.y + window.scrollY,
  }
}

interface Origin {
  x: number
  y: number
  clip: DOMRect
}

/**
 * getBoundingClientRect() measures the border box, while the child's own origin sits inside
 * the border — so the border width is added rather than assumed to be zero.
 */
function originOf(frame: EmbeddedFrame): Origin {
  const rect = frame.getBoundingClientRect()
  const style = getComputedStyle(frame)
  return {
    x: rect.x + parseFloat(style.borderLeftWidth || '0'),
    y: rect.y + parseFloat(style.borderTopWidth || '0'),
    clip: rect,
  }
}

/**
 * Move a child's box into this frame's coordinates, clipped to the iframe.
 *
 * Clipping matters: content scrolled out of view inside the frame would otherwise be drawn
 * — or clicked — somewhere it is not. A box left with no area is dropped.
 */
function translate(box: Bounds, origin: Origin): Bounds | undefined {
  const left = Math.max(origin.x + box.x, origin.clip.left)
  const top = Math.max(origin.y + box.y, origin.clip.top)
  const right = Math.min(origin.x + box.x + box.width, origin.clip.right)
  const bottom = Math.min(origin.y + box.y + box.height, origin.clip.bottom)
  if (right <= left || bottom <= top) return undefined

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    documentX: left + window.scrollX,
    documentY: top + window.scrollY,
  }
}

// ---------------------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------------------

/**
 * Every embedded document in this one, including inside open shadow roots.
 *
 * <frame> inside a <frameset> is a separate class from <iframe> and was invisible here. It
 * is legacy markup, but it is exactly what the old automation-practice pages use — the
 * ui.vision frames demo reported six frames and zero elements until this matched both.
 */
type EmbeddedFrame = HTMLIFrameElement | HTMLFrameElement

function* eachIframe(root: ParentNode): Generator<EmbeddedFrame> {
  for (const el of root.querySelectorAll('*')) {
    if (el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement) yield el
    if (el.shadowRoot) yield* eachIframe(el.shadowRoot)
  }
}

/** Fields in this frame holding a secret, for masking. Bounds only. */
function sensitiveFieldRegions(): Bounds[] {
  const regions: Bounds[] = []
  for (const el of document.querySelectorAll('input, textarea, [contenteditable]')) {
    if (!classifySensitive(el)) continue

    const filled =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.value.length > 0
        : (el.textContent ?? '').trim().length > 0
    if (!filled) continue

    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) regions.push(bounds(rect))
  }
  return regions
}

/** A label for the iframe node in the tree, without leaking a query string. */
function frameLabel(frame: EmbeddedFrame): string {
  const title = frame.getAttribute('title')?.trim()
  if (title) return title
  try {
    return new URL(frame.src, location.href).host
  } catch {
    return 'embedded frame'
  }
}

/**
 * This frame's own contents, plus everything its children report, translated into this
 * frame's coordinates and nested under a node for the iframe they came from.
 */
export async function collectFrame(depth = 0): Promise<FramePayload> {
  const { elements, kept, counts } = scanInteractive()
  const roots = buildTree(elements, kept)
  const regions = [...sensitiveFieldRegions(), ...piiTextRegions()]

  if (depth >= MAX_DEPTH) return { elements, roots, regions, counts }

  const frames = [...eachIframe(document)]
    .filter((frame) => {
      const rect = frame.getBoundingClientRect()
      return (
        frame.contentWindow && rect.width >= MIN_FRAME_SIZE && rect.height >= MIN_FRAME_SIZE
      )
    })
    .slice(0, MAX_FRAMES)
  if (!frames.length) return { elements, roots, regions, counts }

  const nonce = nonces()
  const pending = new Map<Window, { frame: EmbeddedFrame; index: number }>()
  frames.forEach((frame, i) => {
    pending.set(frame.contentWindow!, { frame, index: i + 1 })
  })

  const gathered: { frame: EmbeddedFrame; payload: FramePayload; source: Window }[] = []

  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, SCAN_TIMEOUT_MS)

    function finish(): void {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve()
    }

    function onMessage(event: MessageEvent): void {
      if (!isEnvelope(event.data, SCAN_RES) || event.data.nonce !== nonce) return

      const source = event.source as Window | null
      const entry = source ? pending.get(source) : undefined
      if (!entry || !event.data.payload) return
      pending.delete(source!)

      gathered.push({ frame: entry.frame, payload: event.data.payload, source: source! })
      if (!pending.size) finish()
    }

    window.addEventListener('message', onMessage)
    for (const [target, { index }] of pending) {
      // The tag grows by one segment per level, so two frames at the same index under
      // different parents never share a handle namespace.
      target.postMessage(
        { __aegis: SCAN_REQ, nonce, tag: `${handleTag()}f${index}-`, depth: depth + 1 } satisfies Envelope,
        '*',
      )
    }
  })

  for (const { frame, payload, source } of gathered) {
    const origin = originOf(frame)

    for (const region of payload.regions.slice(0, MAX_REGIONS_PER_FRAME)) {
      const moved = translate(region, origin)
      if (moved) regions.push(moved)
    }

    // Translate and renumber together, indexed by the child's own id so the elements array
    // and the tree that references them cannot drift apart.
    const moved = new Map<number, InteractiveElement>()
    for (const element of payload.elements.slice(0, MAX_ELEMENTS_PER_FRAME)) {
      const box = translate(element.bounds, origin)
      if (!box) continue

      const id = nextForeignId(elements)
      const translated = { ...element, id, bounds: box }
      moved.set(element.id, translated)
      elements.push(translated)
      owners.set(id, { window: source, localId: element.id })
    }

    roots.push({
      kind: 'container',
      tag: 'iframe',
      name: frameLabel(frame),
      children: rebind(payload.roots, moved),
    })
  }

  return { elements, roots, regions, counts }
}

/**
 * The next id free in this frame's numbering. Sequential rather than blocked, so nesting
 * depth places no ceiling on how many elements a frame may contribute.
 */
function nextForeignId(elements: readonly InteractiveElement[]): number {
  let max = 0
  for (const element of elements) if (element.id > max) max = element.id
  return max + 1
}

/**
 * Rebuild a child's tree against the translated elements, dropping nodes whose element was
 * clipped away — a branch pointing at an element nobody can act on is worse than absent.
 */
function rebind(nodes: readonly TreeNode[], moved: Map<number, InteractiveElement>): TreeNode[] {
  const out: TreeNode[] = []

  for (const node of nodes) {
    const children = rebind(node.children ?? [], moved)

    if (node.kind === 'container') {
      if (children.length) out.push({ ...node, children })
      continue
    }

    const element = moved.get(node.element.id)
    if (element) out.push({ ...node, element, children })
    else out.push(...children)
  }

  return out
}

// ---------------------------------------------------------------------------------------
// Answering, and forwarding actions
// ---------------------------------------------------------------------------------------

/** Send an action to the frame that owns the element, and wait for its result. */
export async function forwardAction(target: Window, action: PageAction): Promise<ActionResult> {
  const nonce = nonces()

  return new Promise<ActionResult>((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      resolve({ ok: false, message: 'The frame holding that element did not respond.' })
    }, ACT_TIMEOUT_MS)

    function onMessage(event: MessageEvent): void {
      if (!isEnvelope(event.data, ACT_RES) || event.data.nonce !== nonce) return
      if (event.source !== target) return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      resolve(event.data.result ?? { ok: false, message: 'The frame returned no result.' })
    }

    window.addEventListener('message', onMessage)
    target.postMessage({ __aegis: ACT_REQ, nonce, action } satisfies Envelope, '*')
  })
}

/**
 * Run an action here, or pass it on to the frame that owns the element.
 *
 * Every frame uses this, not just the top one. A forwarded action arrives by postMessage
 * rather than through the extension's message port, so a responder that executed directly
 * would stop routing at the first hop — an element two frames deep resolved against the
 * wrong registry, or not at all.
 */
export async function dispatchAction(action: PageAction): Promise<ActionResult> {
  const elementId = (action as { elementId?: number }).elementId
  const owner = elementId === undefined ? undefined : owners.get(elementId)
  if (!owner) return executePageAction(action)

  // The child numbers its own elements, so the id is translated back on the way in.
  return forwardAction(owner.window, { ...action, elementId: owner.localId } as PageAction)
}

/**
 * Answer the frame that embeds this one. Installed everywhere, since a frame is a child to
 * its parent and a parent to whatever it embeds.
 */
export function installFrameResponder(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    // Only the frame that embeds this one may ask.
    if (event.source !== window.parent || event.source === window) return

    if (isEnvelope(event.data, SCAN_REQ)) {
      const { nonce, tag, depth } = event.data
      setFrameHandleTag(tag ?? '')

      void collectFrame(depth ?? 1).then((payload) => {
        ;(event.source as Window).postMessage(
          { __aegis: SCAN_RES, nonce, payload } satisfies Envelope,
          '*',
        )
      })
      return
    }

    if (isEnvelope(event.data, ACT_REQ) && event.data.action) {
      const { nonce, action } = event.data
      void dispatchAction(action)
        .then((result) => {
          ;(event.source as Window).postMessage(
            { __aegis: ACT_RES, nonce, result } satisfies Envelope,
            '*',
          )
        })
        .catch((err: unknown) => {
          ;(event.source as Window).postMessage(
            {
              __aegis: ACT_RES,
              nonce,
              result: { ok: false, message: err instanceof Error ? err.message : String(err) },
            } satisfies Envelope,
            '*',
          )
        })
    }
  })
}
