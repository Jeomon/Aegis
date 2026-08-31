/**
 * The tool a model calls.
 *
 * One `browser` tool with an `action` discriminator, following browser_use's design:
 * every field is optional in the schema and the required combinations are enforced at
 * runtime, because provider support for `oneOf`/conditional schemas is uneven and a
 * rejected request is worse than a clear validation error the model can recover from.
 *
 * The shape emitted here is the OpenAI function-tool shape, which the open-weights
 * providers (Together, OpenRouter, Fireworks) accept for Qwen2.5-VL.
 */

import type { BrowserAction, MouseButton, ScrollDirection, TabOp } from './actions'

export const ACTION_NAMES = [
  'click', 'type', 'scroll', 'wait', 'goto', 'back', 'forward', 'tab',
] as const

export type ActionName = (typeof ACTION_NAMES)[number]

export const BROWSER_TOOL = {
  type: 'function',
  function: {
    name: 'browser',
    description:
      'Drive the browser through one action-based tool. Interact with the page using ' +
      'the [id] labels from the current observation (click, type, scroll), move between ' +
      'pages with goto/back/forward, and manage tabs with tab.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [...ACTION_NAMES],
          description:
            'click (press an element), type (enter text, press keys, or choose a ' +
            'dropdown option), scroll (by amount or to text), wait, goto (navigate; ' +
            'omit url to reload), back, forward, tab (list/switch/close/new).',
        },
        elementId: {
          type: 'integer',
          description:
            'Element id from the current observation — the [123] labels. Required for ' +
            'click. Ids change when the page changes, so only use ones from the latest ' +
            'observation.',
        },
        text: {
          type: 'string',
          description:
            'For type: the text to enter, or the visible option text when the target is ' +
            'a dropdown (omit to list its options). For scroll: scroll until this text ' +
            'is on screen instead of scrolling by an amount.',
        },
        keys: {
          type: 'string',
          description:
            "For type: a key or chord to press instead of text, e.g. 'Enter', 'Escape', " +
            "'CTRL+a'.",
        },
        clear: {
          type: 'boolean',
          description: 'For type: replace the field contents instead of appending.',
        },
        pressEnter: {
          type: 'boolean',
          description: 'For type: press Enter after entering the text.',
        },
        isSensitive: {
          type: 'boolean',
          description:
            'For type: mark the text as a secret so it is never echoed back in results.',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'For click: which mouse button. Defaults to left.',
        },
        clicks: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: 'For click: click count. 2 is a double click.',
        },
        newTab: {
          type: 'boolean',
          description:
            'For click: the element must be a link, and it opens in a new tab. For ' +
            'goto: open the url in a new tab instead of navigating in place.',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'For scroll: which way. Defaults to down.',
        },
        amount: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          description: 'For scroll: distance in pixels. Defaults to 600.',
        },
        seconds: {
          type: 'number',
          minimum: 0,
          maximum: 30,
          description: 'For wait: how long to pause.',
        },
        url: {
          type: 'string',
          description:
            'For goto and tab=new: the destination. A bare host like "wikipedia.org" is ' +
            'accepted. Omit for goto to reload the current page.',
        },
        op: {
          type: 'string',
          enum: ['list', 'switch', 'close', 'new'],
          description: 'For tab: which tab operation to perform.',
        },
        tabId: {
          type: 'integer',
          description: 'For tab with op=switch or op=close: the tab id from tab/list.',
        },
      },
    },
  },
} as const

/** Guidance that belongs in the system prompt alongside the tool. */
export const TOOL_GUIDELINES = [
  'A fresh browser observation is provided every turn — the current page, its tabs, and',
  'the interactive elements as an indented tree. Do not ask for it; read it.',
  '',
  'Interact through the [id] labels from that observation. Ids are stale as soon as the',
  'page changes, so always use the latest ones.',
  '',
  'Set isSensitive=true when typing anything secret. Stop and ask the user at login walls',
  'rather than guessing credentials, and confirm before anything destructive or',
  'irreversible.',
].join('\n')

export type ValidationResult =
  | { ok: true; action: BrowserAction }
  | { ok: false; error: string }

/** Narrow an unknown tool-call payload to a BrowserAction, or explain why not. */
export function validateToolInput(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Tool input must be an object.' }
  }

  const raw = input as Record<string, unknown>
  const action = raw.action

  if (typeof action !== 'string' || !ACTION_NAMES.includes(action as ActionName)) {
    return {
      ok: false,
      error: `'action' must be one of: ${ACTION_NAMES.join(', ')}.`,
    }
  }

  const int = (key: string): number | undefined =>
    typeof raw[key] === 'number' && Number.isInteger(raw[key]) ? (raw[key] as number) : undefined
  const str = (key: string): string | undefined =>
    typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : undefined
  const bool = (key: string): boolean | undefined =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : undefined

  switch (action as ActionName) {
    case 'click': {
      const elementId = int('elementId')
      if (elementId === undefined) {
        return { ok: false, error: "'elementId' is required when action='click'." }
      }
      return {
        ok: true,
        action: {
          type: 'click',
          elementId,
          button: str('button') as MouseButton | undefined,
          clicks: int('clicks'),
          newTab: bool('newTab'),
        },
      }
    }

    case 'type': {
      const text = str('text')
      const keys = str('keys')
      const elementId = int('elementId')
      // Text, keys, or a bare dropdown listing (elementId with neither) are all valid.
      if (text === undefined && keys === undefined && elementId === undefined) {
        return {
          ok: false,
          error: "action='type' needs 'text', 'keys', or an 'elementId' to list a dropdown.",
        }
      }
      return {
        ok: true,
        action: {
          type: 'type',
          elementId,
          text,
          keys,
          clear: bool('clear'),
          pressEnter: bool('pressEnter'),
          isSensitive: bool('isSensitive'),
        },
      }
    }

    case 'scroll': {
      const direction = str('direction')
      if (direction !== undefined && !['up', 'down', 'left', 'right'].includes(direction)) {
        return { ok: false, error: "'direction' must be up, down, left or right." }
      }
      return {
        ok: true,
        action: {
          type: 'scroll',
          direction: direction as ScrollDirection | undefined,
          amount: int('amount'),
          text: str('text'),
        },
      }
    }

    case 'wait': {
      const seconds = typeof raw.seconds === 'number' ? raw.seconds : undefined
      if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
        return { ok: false, error: "'seconds' is required when action='wait'." }
      }
      return { ok: true, action: { type: 'wait', seconds: Math.min(seconds, 30) } }
    }

    case 'goto':
      return { ok: true, action: { type: 'goto', url: str('url'), newTab: bool('newTab') } }

    case 'back':
      return { ok: true, action: { type: 'back' } }

    case 'forward':
      return { ok: true, action: { type: 'forward' } }

    case 'tab': {
      const op = str('op')
      if (op === undefined || !['list', 'switch', 'close', 'new'].includes(op)) {
        return { ok: false, error: "'op' must be list, switch, close or new." }
      }
      const tabId = int('tabId')
      if ((op === 'switch' || op === 'close') && tabId === undefined) {
        return { ok: false, error: `'tabId' is required when op='${op}'.` }
      }
      return { ok: true, action: { type: 'tab', op: op as TabOp, tabId, url: str('url') } }
    }
  }
}
