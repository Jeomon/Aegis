/**
 * Text to action.
 *
 * The panel has no model behind it yet, so commands are typed by hand. They parse into
 * exactly the `BrowserAction` objects a model will emit later, so nothing downstream
 * changes when one is wired in.
 *
 * Friendly aliases survive the merge — `press`, `select`, `find` and `refresh` are still
 * accepted, they just resolve onto `type`, `scroll` and `goto`.
 */

import type { BrowserAction, ScrollDirection } from '../shared/actions'

const SCROLL_DIRECTIONS = new Set<string>(['up', 'down', 'left', 'right'])

export const COMMAND_HELP = [
  'Page:    scan · click <id> [newtab] · type <id> <text> · press <keys>',
  '         select <id> [option] · scroll <dir> [px] · find <text> · wait <s>',
  'Browser: go <url> · refresh · back · forward · shot',
  'Tabs:    tabs · tab <id> · close <id> · newtab [url]',
  'Model:   obs (the message a model gets) · tool {"action":"click","elementId":3}',
  'Setup:   config · use <provider> [model] · key <provider> <value> · key clear <provider>',
].join('\n')

/** Returns null when the input is not a command, so it can fall through to chat. */
export function parseCommand(input: string): BrowserAction | null {
  const trimmed = input.trim()
  const [head, ...rest] = trimmed.split(/\s+/)
  const verb = head?.toLowerCase() ?? ''
  const tail = trimmed.slice(head?.length ?? 0).trim()

  switch (verb) {
    case 'back':
      return { type: 'back' }
    case 'forward':
      return { type: 'forward' }

    case 'refresh':
    case 'reload':
      return { type: 'goto' } // no url means reload

    case 'go':
    case 'goto':
    case 'open':
      // A destination is one token. "go to google and tell me the weather in kochi" is a
      // sentence that happens to start with a command word, and treating its remainder as
      // a URL navigated to "https://to google and tell me..." without ever asking the
      // model. Anything with a space is prose, and belongs to the agent.
      return tail && !/\s/.test(tail) ? { type: 'goto', url: tail } : null

    case 'tabs':
      return { type: 'tab', op: 'list' }

    case 'newtab':
      return { type: 'tab', op: 'new', url: tail || undefined }

    case 'tab': {
      const tabId = Number(rest[0])
      return Number.isInteger(tabId) ? { type: 'tab', op: 'switch', tabId } : null
    }

    case 'close': {
      const tabId = Number(rest[0])
      return Number.isInteger(tabId) ? { type: 'tab', op: 'close', tabId } : null
    }

    case 'click': {
      const elementId = Number(rest[0])
      if (!Number.isInteger(elementId)) return null
      const newTab = rest[1]?.toLowerCase() === 'newtab'
      return { type: 'click', elementId, newTab: newTab || undefined }
    }

    case 'type': {
      // "type 12 hello world" targets an element; "type hello world" the focused one.
      const maybeId = Number(rest[0])
      if (Number.isInteger(maybeId) && rest.length > 1) {
        return { type: 'type', elementId: maybeId, text: rest.slice(1).join(' '), clear: true }
      }
      return tail ? { type: 'type', text: tail, clear: true } : null
    }

    case 'press':
      return rest[0] ? { type: 'type', keys: rest[0] } : null

    case 'select': {
      const elementId = Number(rest[0])
      if (!Number.isInteger(elementId)) return null
      const option = rest.slice(1).join(' ')
      // With no option this lists them, which `type` on a <select> already does.
      return { type: 'type', elementId, text: option || undefined }
    }

    case 'scroll': {
      const direction = (rest[0] ?? 'down').toLowerCase()
      if (!SCROLL_DIRECTIONS.has(direction)) return null
      const amount = Number(rest[1])
      return {
        type: 'scroll',
        direction: direction as ScrollDirection,
        amount: Number.isFinite(amount) ? amount : undefined,
      }
    }

    case 'find':
      return tail ? { type: 'scroll', text: tail } : null

    case 'wait': {
      const seconds = Number(rest[0] ?? 1)
      return Number.isFinite(seconds) ? { type: 'wait', seconds } : null
    }

    default:
      return null
  }
}

/** Actions after which the page has probably moved on, so ids need refreshing. */
export function invalidatesScan(action: BrowserAction): boolean {
  if (action.type === 'wait') return false
  if (action.type === 'tab' && action.op === 'list') return false
  return true
}

/** Actions that start a page load, so the rescan should wait for it. */
export function startsNavigation(action: BrowserAction): boolean {
  return action.type === 'goto' || action.type === 'back' || action.type === 'forward'
}
