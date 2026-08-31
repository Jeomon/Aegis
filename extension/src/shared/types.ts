import type { SensitiveKind } from '../page/sensitive'

export type Role = 'user' | 'assistant'

export interface Message {
  role: Role
  text: string
  /** Render in a monospace block — used for the element tree. */
  mono?: boolean
  /** Dimmed and italic — used for the model's reasoning trace. */
  dim?: boolean
  /**
   * A tool the agent invoked. Rendered as an activity card rather than a chat bubble —
   * it is something that happened, not something anyone said.
   */
  tool?: {
    verb: string
    detail: string
    /** The raw arguments, kept behind a disclosure for debugging. */
    raw: string
    result?: string
    ok?: boolean
  }
}

/** What the panel knows about the tab it is sitting next to. */
export interface PageContext {
  title: string
  url: string
  host: string
}

/** Element rectangle. Viewport coordinates for hit-testing, document for overlays. */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
  documentX: number
  documentY: number
}

/** One interactive control, addressed by `id` the way CDP addresses by backendNodeId. */
export interface InteractiveElement {
  id: number
  tag: string
  role: string
  name: string
  states: string[]
  bounds: Bounds
  /** Interactive in its own right, rather than via an inherited cursor/tabindex signal. */
  strong: boolean
  scrollable: boolean
  /** Lives inside an open shadow root. */
  shadow: boolean
  /**
   * What kind of secret this control holds, from layer 1 of the redaction cascade. The
   * text channel masks the value; the pixel channel masks `bounds`. Both read this, so the
   * two views can never disagree about what is hidden.
   */
  sensitive?: SensitiveKind
}

/**
 * A node in the observation tree. Containers are unnumbered scaffolding — they exist to
 * convey page structure (a form over its fields, a nav over its links) and are never
 * addressable, so only elements carry an id.
 */
export type TreeNode =
  | { kind: 'element'; element: InteractiveElement; children: TreeNode[] }
  | { kind: 'container'; tag: string; name: string; children: TreeNode[] }

/** How many elements survived each stage — useful for tuning and for the demo. */
export interface ScanCounts {
  visited: number
  interactive: number
  afterNameDedup: number
  afterOcclusion: number
  final: number
}

export interface ScanResult {
  elements: InteractiveElement[]
  roots: TreeNode[]
  viewport: {
    width: number
    height: number
    scrollX: number
    scrollY: number
    devicePixelRatio: number
  }
  url: string
  title: string
  scanMs: number
  counts: ScanCounts
}

export interface ScanError {
  error: string
}

export type ScanMessage = { type: 'AEGIS_SCAN' }
