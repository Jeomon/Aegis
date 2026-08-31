/**
 * The action vocabulary.
 *
 * Eight actions, condensed from browser_use's seventeen: keyboard input and dropdown
 * selection both fold into `type`, scrolling to text folds into `scroll`, reloading folds
 * into `goto`, and the three tab operations fold into `tab`.
 *
 * The split is exact — click/type/scroll/wait run inside the page, goto/back/forward/tab
 * run in the panel through chrome.tabs. Screenshot is deliberately not here: capture
 * belongs to the observation path, which feeds redaction, not to the agent's repertoire.
 *
 * A model wired in later emits exactly these objects.
 */

export type MouseButton = 'left' | 'right' | 'middle'
export type ScrollDirection = 'up' | 'down' | 'left' | 'right'
export type TabOp = 'list' | 'switch' | 'close' | 'new'

/** Executed inside the page by the content script, addressed by scan id. */
export type PageAction =
  | {
      type: 'click'
      elementId: number
      button?: MouseButton
      clicks?: number
      /** Resolve the element's href and open it directly — Chromium ignores synthetic ctrl-click. */
      newTab?: boolean
    }
  | {
      type: 'type'
      elementId?: number
      /** Text to type, or the option text to choose when the target is a <select>. */
      text?: string
      /** A key or chord instead of text, e.g. 'Enter', 'Escape', 'CTRL+a'. */
      keys?: string
      clear?: boolean
      pressEnter?: boolean
      /** Suppress the value in results and logs. */
      isSensitive?: boolean
    }
  | {
      type: 'scroll'
      direction?: ScrollDirection
      amount?: number
      /** Scroll until this text is on screen, instead of by a fixed amount. */
      text?: string
    }
  | { type: 'wait'; seconds: number }

/** Executed by the side panel through chrome.tabs. */
export type TabAction =
  | { type: 'goto'; url?: string; newTab?: boolean }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'tab'; op: TabOp; tabId?: number; url?: string }
  /** Arbitrary JavaScript, evaluated in the page's own world. */
  | { type: 'evaluate'; code: string }

export type BrowserAction = PageAction | TabAction

const PAGE_ACTIONS = new Set<BrowserAction['type']>(['click', 'type', 'scroll', 'wait'])

export function isPageAction(action: BrowserAction): action is PageAction {
  return PAGE_ACTIONS.has(action.type)
}

export interface ActionResult {
  ok: boolean
  /** Human-readable outcome, in the same voice as browser_use's tool results. */
  message: string
  /** Extra payload — the tab list, a dropdown's options. */
  data?: unknown
  /**
   * Set when an element id could not be resolved, so the caller rescans and retries
   * rather than treating it as a hard failure.
   */
  staleId?: boolean
}

export const ACT_MESSAGE = 'AEGIS_ACT' as const

export interface ActMessage {
  type: typeof ACT_MESSAGE
  action: PageAction
}
