/**
 * Turn a raw tool call into something readable.
 *
 * `{"action":"click","elementId":21}` says what the wire carries; "Click [21]" says what
 * happened. The raw JSON stays available underneath for debugging, but it should not be
 * the first thing a person reads.
 */

import type { BrowserAction } from '../actions'

export interface ActionSummary {
  /** Short imperative verb, shown as the card's title. */
  verb: string
  /** The specifics, shown next to it. Empty when the verb says everything. */
  detail: string
}

const TAB_VERBS: Record<string, string> = {
  list: 'List tabs',
  switch: 'Switch tab',
  close: 'Close tab',
  new: 'New tab',
}

export function describeAction(raw: string): ActionSummary {
  let action: Partial<BrowserAction> & Record<string, unknown>
  try {
    action = JSON.parse(raw)
  } catch {
    return { verb: 'Tool call', detail: 'unreadable arguments' }
  }

  switch (action.action ?? action.type) {
    case 'click': {
      const target = action.elementId === undefined ? '' : `[${action.elementId}]`
      const where = action.newTab ? ' in a new tab' : ''
      return { verb: 'Click', detail: `${target}${where}` }
    }

    case 'type': {
      const target = action.elementId === undefined ? 'the focused field' : `[${action.elementId}]`

      if (action.keys && action.text === undefined) {
        return { verb: 'Press', detail: String(action.keys) }
      }
      if (action.text === undefined) {
        return { verb: 'List options', detail: target }
      }

      // A value marked sensitive must not be echoed here either.
      const shown = action.isSensitive ? '••••••' : `“${truncate(String(action.text), 40)}”`
      const enter = action.pressEnter ? ' then Enter' : ''
      return { verb: 'Type', detail: `${shown} into ${target}${enter}` }
    }

    case 'scroll':
      if (action.text) return { verb: 'Scroll to', detail: `“${truncate(String(action.text), 40)}”` }
      return {
        verb: 'Scroll',
        detail: `${action.direction ?? 'down'}${action.amount ? ` ${action.amount}px` : ''}`,
      }

    case 'wait':
      return { verb: 'Wait', detail: `${action.seconds ?? 1}s` }

    case 'goto':
      if (!action.url) return { verb: 'Reload', detail: '' }
      return {
        verb: 'Go to',
        detail: truncate(String(action.url), 44) + (action.newTab ? ' in a new tab' : ''),
      }

    case 'back':
      return { verb: 'Back', detail: '' }

    case 'forward':
      return { verb: 'Forward', detail: '' }

    // The code itself is the useful detail — the card folds open to the full arguments.
    case 'evaluate':
      return { verb: 'Running JavaScript', detail: truncate(String(action.code ?? ''), 44) }

    case 'tab': {
      const op = String(action.op ?? '')
      const verb = TAB_VERBS[op] ?? 'Tabs'
      return { verb, detail: action.tabId === undefined ? '' : `#${action.tabId}` }
    }

    default:
      return { verb: 'Tool call', detail: String(action.action ?? action.type ?? '') }
  }
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}
