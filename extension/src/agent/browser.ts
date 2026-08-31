/**
 * Action dispatch from the side panel.
 *
 * goto/back/forward/tab run here through chrome.tabs — a content script cannot do them.
 * click/type/scroll/wait are forwarded into the page. Where browser_use holds one CDP
 * session, we hold a tab id and re-inject the content script when it has gone away.
 */

import { ACT_MESSAGE, isPageAction } from '../shared/actions'
import type { ActionResult, BrowserAction, TabAction } from '../shared/actions'
import { validateToolInput } from './tools'
import type { ScanResult } from '../shared/types'

const INTERNAL_PAGE = /^(chrome|edge|about|chrome-extension|devtools|view-source):/

export interface TabInfo {
  tabId: number
  url: string
  title: string
  active: boolean
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('No active tab.')
  if (!tab.url || INTERNAL_PAGE.test(tab.url)) {
    throw new Error('Cannot act on browser-internal pages. Open a normal http(s) page.')
  }
  return tab
}

/**
 * Send into the page, injecting the content script first if the page predates the
 * extension. A fresh injection has no scan behind it, so ids will not resolve until the
 * caller rescans — which is exactly what the staleId path reports.
 */
async function sendToPage<T>(tabId: number, message: unknown): Promise<T> {
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    return await chrome.tabs.sendMessage(tabId, message)
  }
}

export async function scanPage(): Promise<ScanResult> {
  const tab = await activeTab()
  return sendToPage<ScanResult>(tab.id!, { type: 'AEGIS_SCAN' })
}

/**
 * Capture the visible tab. Not an action: this feeds the observation and, later, the
 * redaction pipeline — it is not something the agent chooses to do.
 */
export async function captureScreenshot(): Promise<string> {
  const tab = await activeTab()
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
}

/**
 * Run one action. A stale element id is retried once behind a fresh scan, mirroring
 * browser_use's `element()` which recaptures before giving up.
 */
export async function runAction(action: BrowserAction): Promise<ActionResult> {
  try {
    if (!isPageAction(action)) return await runTabAction(action)

    const tab = await activeTab()
    let result = await sendToPage<ActionResult>(tab.id!, { type: ACT_MESSAGE, action })

    if (result.staleId) {
      await sendToPage<ScanResult>(tab.id!, { type: 'AEGIS_SCAN' })
      result = await sendToPage<ActionResult>(tab.id!, { type: ACT_MESSAGE, action })
    }

    // A new-tab click comes back as a resolved href rather than a navigation, because
    // only this side can open a tab.
    if (result.ok && action.type === 'click' && action.newTab) {
      const href = (result.data as { href?: string } | undefined)?.href
      if (href) await chrome.tabs.create({ url: href })
    }

    return result
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The whole model-facing path: validate a raw tool-call payload, run it, and return the
 * string that goes back as the tool result.
 *
 * A validation failure is returned as ordinary text rather than thrown, because a model
 * recovers from "'elementId' is required" far better than from an exception.
 */
export async function executeToolCall(input: unknown): Promise<{ ok: boolean; message: string }> {
  const validated = validateToolInput(input)
  if (!validated.ok) return { ok: false, message: `Invalid tool call: ${validated.error}` }

  const result = await runAction(validated.action)
  return { ok: result.ok, message: result.ok ? result.message : `Failed: ${result.message}` }
}

async function runTabAction(action: TabAction): Promise<ActionResult> {
  switch (action.type) {
    case 'goto': {
      // No url means reload the current page.
      if (!action.url) {
        const tab = await activeTab()
        await chrome.tabs.reload(tab.id!)
        return { ok: true, message: 'Page reloaded.' }
      }
      const url = normaliseUrl(action.url)
      if (action.newTab) {
        await chrome.tabs.create({ url })
        return { ok: true, message: `Opened ${url} in a new tab.` }
      }
      const tab = await activeTab()
      await chrome.tabs.update(tab.id!, { url })
      return { ok: true, message: `Navigated to ${url}.` }
    }

    case 'back': {
      const tab = await activeTab()
      await chrome.tabs.goBack(tab.id!)
      return { ok: true, message: 'Went back.' }
    }

    case 'forward': {
      const tab = await activeTab()
      await chrome.tabs.goForward(tab.id!)
      return { ok: true, message: 'Went forward.' }
    }

    case 'tab':
      return runTabOp(action)

    case 'evaluate':
      return evaluateInPage(action.code)
  }
}

/** Anything longer floods the context without telling the model much more. */
const MAX_RESULT = 2000

/**
 * Run JavaScript in the page's own world.
 *
 * MAIN rather than the content script's isolated world, because the point of evaluate is to
 * see the page as the page sees it — its globals, its framework state — not the sanitised
 * view an isolated world gets. The result is serialised inside the page, since a DOM node
 * cannot cross the boundary that separates the two.
 *
 * Note that this reads the live page unfiltered, including values the observation withholds.
 */
async function evaluateInPage(code: string): Promise<ActionResult> {
  const tab = await activeTab()

  let injected
  try {
    ;[injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      world: 'MAIN',
      args: [code],
      func: async (source: string) => {
        const describe = (value: unknown): string => {
          if (value === undefined) return 'undefined'
          if (value === null) return 'null'
          if (typeof value === 'string') return value
          // A DOM node serialises to '{}', which reads as an empty result rather than a
          // node, so elements and node lists are rendered as markup instead.
          if (value instanceof Element) return value.outerHTML
          if (value instanceof NodeList || value instanceof HTMLCollection) {
            return Array.from(value as ArrayLike<unknown>)
              .map((n) => (n instanceof Element ? n.outerHTML : String(n)))
              .join('\n')
          }
          try {
            return JSON.stringify(value) ?? String(value)
          } catch {
            return String(value)
          }
        }

        try {
          // Indirect eval, so the code runs in global scope rather than this closure.
          let value: unknown = (0, eval)(source)
          if (value instanceof Promise) value = await value
          return { ok: true, text: describe(value) }
        } catch (err: unknown) {
          return { ok: false, text: err instanceof Error ? err.message : String(err) }
        }
      },
    })
  } catch (err: unknown) {
    // A page whose CSP forbids eval rejects the injection itself, which is worth saying
    // plainly rather than reporting as a script error.
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `Could not evaluate on this page: ${message}` }
  }

  const outcome = injected?.result as { ok: boolean; text: string } | undefined
  if (!outcome) return { ok: false, message: 'Evaluate returned nothing.' }

  const text =
    outcome.text.length > MAX_RESULT
      ? `${outcome.text.slice(0, MAX_RESULT)}\n… truncated at ${MAX_RESULT} characters.`
      : outcome.text

  if (outcome.ok) return { ok: true, message: text || '(no value)' }

  if (/Content Security Policy|unsafe-eval/i.test(text)) {
    return {
      ok: false,
      message:
        "This page's Content Security Policy forbids evaluating JavaScript, so evaluate " +
        'cannot be used here. Use the observation and the click/type/scroll actions instead.',
    }
  }

  return { ok: false, message: `JavaScript error: ${text}` }
}

async function runTabOp(action: Extract<TabAction, { type: 'tab' }>): Promise<ActionResult> {
  switch (action.op) {
    case 'list': {
      const tabs = await chrome.tabs.query({ currentWindow: true })
      const info: TabInfo[] = tabs
        .filter((tab) => tab.id !== undefined)
        .map((tab) => ({
          tabId: tab.id!,
          url: tab.url ?? '',
          title: tab.title ?? '',
          active: tab.active,
        }))
      const lines = info.map(
        (tab) => `${tab.active ? '*' : ' '} [${tab.tabId}] ${JSON.stringify(tab.title)} ${tab.url}`,
      )
      return { ok: true, message: lines.join('\n') || 'No tabs.', data: info }
    }

    case 'switch':
      if (action.tabId === undefined) return { ok: false, message: 'switch needs a tab id.' }
      await chrome.tabs.update(action.tabId, { active: true })
      return { ok: true, message: `Switched to tab ${action.tabId}.` }

    case 'close':
      if (action.tabId === undefined) return { ok: false, message: 'close needs a tab id.' }
      await chrome.tabs.remove(action.tabId)
      return { ok: true, message: `Closed tab ${action.tabId}.` }

    case 'new': {
      const url = action.url ? normaliseUrl(action.url) : undefined
      const tab = await chrome.tabs.create(url ? { url } : {})
      return { ok: true, message: `Opened tab ${tab.id}${url ? ` at ${url}` : ''}.` }
    }
  }
}

/** Accept "wikipedia.org" as readily as a full URL. */
function normaliseUrl(input: string): string {
  const trimmed = input.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
