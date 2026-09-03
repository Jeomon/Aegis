/**
 * What a redacted value is. Layer 1 derives these from the DOM, layer 2 from the text
 * itself, and both feed the same vault — so a value masked in one channel and matched in
 * the other cannot become two unrelated secrets.
 */
export type SensitiveKind =
  | 'password'
  | 'one-time-code'
  | 'cc-number'
  | 'cc-csc'
  | 'cc-exp'
  | 'email'
  | 'tel'
  | 'street-address'
  | 'postal-code'
  | 'bday'
  | 'name'
  | 'aadhaar'
  | 'pan'
  | 'gstin'
  | 'ifsc'
  | 'account'

export type Role = 'user' | 'assistant'

export interface Message {
  role: Role
  text: string
  /** Render in a monospace block — used for the element tree. */
  mono?: boolean
  /** Dimmed and italic — used for the model's reasoning trace. */
  dim?: boolean
  /**
   * A capture to show inline, already redacted and labelled. Carried as a data URL because
   * that is what crosses to the model — showing anything else here would let the panel and
   * the request disagree about what was sent.
   */
  image?: string
  /** What a scan withheld, rendered as a result rather than a sentence. */
  receipt?: { summary: string; masked: number }
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
  /**
   * Where layer 2 found identifiers in rendered text. Geometry only — these belong to no
   * element, so they exist purely to be painted out of the screenshot.
   */
  piiRegions: Bounds[]
  scanMs: number
  counts: ScanCounts
}

export interface ScanError {
  error: string
}

export type ScanMessage = { type: 'AEGIS_SCAN' }
