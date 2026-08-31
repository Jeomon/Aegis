/**
 * Element interaction, executed inside the page.
 *
 * browser_use dispatches these through CDP's Input domain, which produces trusted events.
 * A content script can only synthesise them, so two things need care: the event sequence
 * has to look real enough for framework listeners, and value changes have to go through
 * the native setter or React ignores them.
 */

import type { ActionResult, MouseButton, PageAction, ScrollDirection } from '../actions'
import { resolveElement } from './scan'

const BUTTON_CODES: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 }

const SCROLL_DELTAS: Record<ScrollDirection, (n: number) => ScrollToOptions> = {
  down: (n) => ({ top: n }),
  up: (n) => ({ top: -n }),
  right: (n) => ({ left: n }),
  left: (n) => ({ left: -n }),
}

function ok(message: string, data?: unknown): ActionResult {
  return { ok: true, message, data }
}

function fail(message: string, staleId = false): ActionResult {
  return { ok: false, message, staleId }
}

function describe(el: Element): string {
  const label = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return `<${el.tagName.toLowerCase()}>${label ? ` ${JSON.stringify(label)}` : ''}`
}

/** Resolve a scan id, reporting staleness distinctly so the caller can rescan. */
function need(elementId: number): Element | ActionResult {
  const el = resolveElement(elementId)
  if (!el) {
    return fail(
      `Element [${elementId}] is not in the current page state — ids change when the ` +
        'page changes; rescan and use a fresh one.',
      true,
    )
  }
  return el
}

function isResult(value: Element | ActionResult): value is ActionResult {
  return 'ok' in value
}

export async function executePageAction(action: PageAction): Promise<ActionResult> {
  switch (action.type) {
    case 'click':
      return clickAction(action)
    case 'type':
      return typeAction(action)
    case 'scroll':
      return action.text !== undefined
        ? scrollToTextAction(action.text)
        : scrollAction(action.direction ?? 'down', action.amount ?? 600, action.elementId)
    case 'wait':
      await new Promise((resolve) => setTimeout(resolve, action.seconds * 1000))
      return ok(`Waited ${action.seconds}s.`)
  }
}

/* ------------------------------------------------------------------ click */

function clickAction(action: Extract<PageAction, { type: 'click' }>): ActionResult {
  const found = need(action.elementId)
  if (isResult(found)) return found

  // Chromium ignores "open in new tab" on a synthetic click, so hand the href back and
  // let the panel open it — the same resolution browser_use does for new_tab clicks.
  if (action.newTab) {
    const href = found.closest('a')?.href
    if (!href) {
      return fail(`[${action.elementId}] ${describe(found)} is not a link, so it cannot open a tab.`)
    }
    return ok(`Opening ${href} in a new tab.`, { href })
  }

  const button = action.button ?? 'left'
  const clicks = action.clicks ?? 1

  found.scrollIntoView({ block: 'center', inline: 'center' })

  const rect = found.getBoundingClientRect()
  const base: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: BUTTON_CODES[button],
  }

  // Pointer and mouse phases first, so listeners that track press/release see them.
  found.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true }))
  found.dispatchEvent(new MouseEvent('mousedown', base))
  if (found instanceof HTMLElement) found.focus()
  found.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true }))
  found.dispatchEvent(new MouseEvent('mouseup', base))

  // The click itself goes through .click() so the default action runs — following a link,
  // toggling a checkbox, submitting a form. Dispatching a bare click event would not.
  for (let i = 0; i < clicks; i++) {
    if (button === 'left' && found instanceof HTMLElement) found.click()
    else found.dispatchEvent(new MouseEvent('click', { ...base, detail: i + 1 }))
  }

  return ok(`Clicked [${action.elementId}] ${describe(found)}.`)
}

/* ------------------------------------------------------------------ type */

/**
 * React installs its own value tracker on the input, so a plain `el.value = x` is
 * reverted on the next render. Going through the prototype's native setter is what makes
 * the framework observe the change.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

/**
 * Text entry, key presses and dropdown selection, which are all "put this value into this
 * control". The target decides which one happens.
 */
function typeAction(action: Extract<PageAction, { type: 'type' }>): ActionResult {
  let target: Element | null
  if (action.elementId !== undefined) {
    const found = need(action.elementId)
    if (isResult(found)) return found
    target = found
  } else {
    target = document.activeElement
  }

  // A bare key or chord, with no text.
  if (action.keys && action.text === undefined) {
    if (target instanceof HTMLElement) target.focus()
    return pressKeys(action.keys)
  }

  if (!(target instanceof HTMLElement)) return fail('No element to type into.')

  if (target instanceof HTMLSelectElement) return selectOption(target, action.text)

  if (action.text === undefined) return fail('Nothing to type — provide text or keys.')

  target.scrollIntoView({ block: 'center' })
  target.focus()

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    setNativeValue(target, action.clear ? action.text : target.value + action.text)
  } else if (target.isContentEditable) {
    if (action.clear) target.textContent = ''
    target.textContent = (target.textContent ?? '') + action.text
  } else {
    return fail(`${describe(target)} is not a text field.`)
  }

  target.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  target.dispatchEvent(new Event('change', { bubbles: true }))

  const shown = action.isSensitive ? '(sensitive text)' : JSON.stringify(action.text.slice(0, 60))

  if (action.pressEnter || action.keys) {
    const followed = pressKeys(action.keys ?? 'Enter')
    return ok(`Typed ${shown}. ${followed.message}`)
  }
  return ok(`Typed ${shown} into ${describe(target)}.`)
}

function pressKeys(keys: string): ActionResult {
  const parts = keys.split('+')
  const key = parts.pop() ?? ''
  const modifiers = parts.map((part) => part.trim().toUpperCase())

  const target = (document.activeElement as HTMLElement | null) ?? document.body
  const init: KeyboardEventInit = {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: modifiers.includes('CTRL') || modifiers.includes('CONTROL'),
    shiftKey: modifiers.includes('SHIFT'),
    altKey: modifiers.includes('ALT'),
    metaKey: modifiers.includes('META') || modifiers.includes('CMD'),
  }

  const delivered = target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))

  // A synthetic Enter does not submit a form the way a real one does. If nothing called
  // preventDefault, do what the browser would have done.
  if (key === 'Enter' && delivered) {
    const form = target.closest('form')
    if (form) {
      form.requestSubmit()
      return ok('Pressed Enter and submitted the form.')
    }
  }

  return ok(`Pressed ${keys}.`)
}

/** With no text, list the options; with text, choose the matching one. */
function selectOption(select: HTMLSelectElement, wanted?: string): ActionResult {
  const options = [...select.options].map((option) => ({
    text: (option.textContent ?? '').trim(),
    selected: option.selected,
    disabled: option.disabled,
  }))

  if (wanted === undefined) {
    const lines = options.map(
      (option) =>
        `- ${JSON.stringify(option.text)}` +
        (option.selected ? ' (selected)' : '') +
        (option.disabled ? ' (disabled)' : ''),
    )
    return ok(`Dropdown options:\n${lines.join('\n')}`, options)
  }

  const match = [...select.options].find((option) => (option.textContent ?? '').trim() === wanted)
  if (!match) {
    return fail(
      `Option ${JSON.stringify(wanted)} not found — type into this dropdown with no text to list them.`,
    )
  }

  select.value = match.value
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return ok(`Selected ${JSON.stringify(wanted)}.`)
}

/* ------------------------------------------------------------------ scroll */

/**
 * Scroll the window, or a container when an element is named.
 *
 * The tree already flags containers `(scrollable)`, so the model can see them; without a
 * target here it could only ever scroll the window, and content inside a chat list or a
 * modal body stayed unreachable however far the page scrolled.
 */
function scrollAction(
  direction: ScrollDirection,
  amount: number,
  elementId?: number,
): ActionResult {
  const delta = SCROLL_DELTAS[direction](amount)

  if (elementId === undefined) {
    const before = { x: window.scrollX, y: window.scrollY }
    window.scrollBy({ ...delta, behavior: 'instant' })

    const moved = window.scrollX !== before.x || window.scrollY !== before.y
    if (!moved) return ok(`Already at the ${direction} edge of the page.`)
    return ok(`Scrolled ${direction} ${amount}px.`)
  }

  const found = need(elementId)
  if (isResult(found)) return found

  // The labelled element is often a row inside the scroller rather than the scroller
  // itself, so the nearest scrollable ancestor is what actually moves.
  const container = scrollableFrom(found)
  if (!container) {
    return fail(
      `[${elementId}] ${describe(found)} is not inside anything scrollable — scroll the ` +
        'page instead by omitting elementId.',
    )
  }

  const before = { x: container.scrollLeft, y: container.scrollTop }
  container.scrollBy({ ...delta, behavior: 'instant' })

  if (container.scrollLeft === before.x && container.scrollTop === before.y) {
    return ok(`[${elementId}] is already at the ${direction} edge of its container.`)
  }
  return ok(`Scrolled ${direction} ${amount}px inside [${elementId}]'s container.`)
}

/** The element itself if it scrolls, else the nearest ancestor that does. */
function scrollableFrom(start: Element): Element | undefined {
  for (let el: Element | null = start; el; el = el.parentElement) {
    const style = getComputedStyle(el)
    const canScrollY =
      /^(auto|scroll)$/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1
    const canScrollX =
      /^(auto|scroll)$/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1
    if (canScrollY || canScrollX) return el
  }
  return undefined
}

function scrollToTextAction(text: string): ActionResult {
  const needle = text.toLowerCase()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.toLowerCase().includes(needle)) continue
    const host = node.parentElement
    if (!host) continue
    host.scrollIntoView({ block: 'center' })
    return ok(`Scrolled to ${JSON.stringify(text)}.`)
  }

  return fail(`Text ${JSON.stringify(text)} not found on the page.`)
}
