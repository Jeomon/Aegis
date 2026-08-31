/**
 * Accessible name and interactive state, computed from the live DOM.
 *
 * CDP hands browser_use a ready-made accessibility tree; a content script gets nothing,
 * so this is a pragmatic subset of the AccName algorithm — enough to label a control
 * usefully, not a spec-complete implementation.
 */

import { classifySensitive } from './sensitive'
import { redactText } from '../shared/detect'
import { conceal } from './vault'

import { INLINE_ELEMENTS, INTERACTIVE_ROLES, STRONG_INTERACTIVE_TAGS, roleOf } from './roles'

const NAME_LIMIT = 80
const VALUE_LIMIT = 40
const DESCENDANT_TEXT_LIMIT = 120

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Is this element a control in its own right? Used to stop text-gathering at its edge. */
function isOwnControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (STRONG_INTERACTIVE_TAGS.has(tag)) return true
  const role = el.getAttribute('role')?.toLowerCase()
  return role !== undefined && INTERACTIVE_ROLES.has(role)
}

/** Text from the element's own text nodes and its inline children only. */
function inlineText(el: Element): string {
  let out = ''
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? ''
    } else if (node instanceof Element && INLINE_ELEMENTS.has(node.tagName.toLowerCase())) {
      out += node.textContent ?? ''
    }
  }
  return squash(out)
}

/**
 * Text from block descendants, skipping nested controls whose text is their own name.
 * Covers labels that live one level down — a swatch button wrapping its text in a div.
 */
function descendantText(el: Element): string {
  let out = ''

  const visit = (node: Node): void => {
    if (out.length > DESCENDANT_TEXT_LIMIT) return
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? ''
      return
    }
    if (!(node instanceof Element)) return
    if (node !== el && isOwnControl(node)) return // its text names itself, not us
    for (const child of node.childNodes) visit(child)
  }

  visit(el)
  return squash(out)
}

/** Resolve an id-reference list to the concatenated text of those elements. */
function textFromIds(root: Document | ShadowRoot, ids: string): string {
  const parts: string[] = []
  for (const id of ids.split(/\s+/)) {
    if (!id) continue
    const target = root.getElementById?.(id) ?? root.querySelector(`#${CSS.escape(id)}`)
    if (target?.textContent) parts.push(target.textContent)
  }
  return squash(parts.join(' '))
}

/** The <label> associated with a form control, by `for=` or by wrapping. */
function labelText(el: Element): string {
  if (el.id) {
    const root = el.getRootNode()
    const scope = root instanceof ShadowRoot || root instanceof Document ? root : document
    const label = scope.querySelector(`label[for="${CSS.escape(el.id)}"]`)
    if (label?.textContent) return squash(label.textContent)
  }
  const wrapping = el.closest('label')
  if (wrapping?.textContent) return squash(wrapping.textContent)
  return ''
}

/**
 * The element's accessible name, in roughly AccName precedence order, falling back to
 * visible text the way the browser_use parser does.
 */
export function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const root = el.getRootNode()
    const scope = root instanceof ShadowRoot ? root : document
    const text = textFromIds(scope, labelledBy)
    if (text) return truncate(text, NAME_LIMIT)
  }

  const ariaLabel = el.getAttribute('aria-label')?.trim()
  if (ariaLabel) return truncate(squash(ariaLabel), NAME_LIMIT)

  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase()
    // A push-button input is named by its value; a text field is not.
    if (type === 'submit' || type === 'button' || type === 'reset') {
      if (el.value) return truncate(squash(el.value), NAME_LIMIT)
    }
    if (type === 'image' && el.alt) return truncate(squash(el.alt), NAME_LIMIT)
  }

  if (el instanceof HTMLImageElement && el.alt) {
    return truncate(squash(el.alt), NAME_LIMIT)
  }

  const label = labelText(el)
  if (label) return truncate(label, NAME_LIMIT)

  const placeholder = el.getAttribute('placeholder')?.trim()
  if (placeholder) return truncate(squash(placeholder), NAME_LIMIT)

  const title = el.getAttribute('title')?.trim()
  if (title) return truncate(squash(title), NAME_LIMIT)

  const inline = inlineText(el)
  if (inline) return truncate(inline, NAME_LIMIT)

  const descendant = descendantText(el)
  if (descendant) return truncate(descendant, NAME_LIMIT)

  return truncate(squash(el.getAttribute('name') ?? ''), NAME_LIMIT)
}

/**
 * State attributes only ever appear on interactive widgets, so their mere presence is a
 * signal — a <div aria-expanded> accordion toggle with no role or tag, for instance.
 */
export function hasWidgetStateAttributes(el: Element): boolean {
  return (
    el.hasAttribute('aria-checked') ||
    el.hasAttribute('aria-expanded') ||
    el.hasAttribute('aria-pressed') ||
    el.hasAttribute('aria-selected') ||
    el.hasAttribute('aria-required') ||
    el.hasAttribute('aria-haspopup') ||
    el.hasAttribute('aria-keyshortcuts') ||
    el.hasAttribute('aria-autocomplete')
  )
}

/** Whether the element can take focus, which the AX tree would otherwise tell us. */
export function isFocusable(el: Element): boolean {
  const tabindex = el.getAttribute('tabindex')
  if (tabindex !== null && tabindex !== '-1' && tabindex !== '') return true
  if (el instanceof HTMLElement && el.isContentEditable) return true
  const tag = el.tagName.toLowerCase()
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href')
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button') {
    return !(el as HTMLInputElement).disabled
  }
  return tag === 'summary' || tag === 'iframe'
}

/**
 * The interactive states worth surfacing, as short tokens.
 *
 * Values pass through layer 1 of the redaction cascade first. A sensitive field reports
 * that it holds a value and what kind, never the value itself — the agent still needs to
 * know a field is filled, or it will type into it twice.
 */
export function interactiveStates(el: Element): string[] {
  const states: string[] = []

  const ariaChecked = el.getAttribute('aria-checked')
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    if (el.indeterminate) states.push('mixed')
    else if (el.checked) states.push('checked')
  } else if (ariaChecked === 'true') {
    states.push('checked')
  } else if (ariaChecked === 'mixed') {
    states.push('mixed')
  }

  const expanded = el.getAttribute('aria-expanded')
  if (expanded === 'true') states.push('expanded')
  else if (expanded === 'false') states.push('collapsed')

  const pressed = el.getAttribute('aria-pressed')
  if (pressed === 'true') states.push('pressed')
  else if (pressed === 'mixed') states.push('pressed:mixed')

  if (el.getAttribute('aria-selected') === 'true') states.push('selected')
  if (el instanceof HTMLOptionElement && el.selected) states.push('selected')

  const disabled =
    (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
  if (disabled) states.push('disabled')

  const required =
    (el as HTMLInputElement).required === true || el.getAttribute('aria-required') === 'true'
  if (required) states.push('required')

  const haspopup = el.getAttribute('aria-haspopup')
  if (haspopup && haspopup !== 'false') states.push(`haspopup=${haspopup}`)

  const value = currentValue(el)
  if (value) {
    const kind = classifySensitive(el)
    // A handle rather than a bare label, so the agent can direct the value back into a
    // field without ever being shown it.
    if (kind) {
      states.push(`value=${conceal(kind, value)}`)
    } else {
      // No declared kind, but the text itself may still be an identifier — an Aadhaar
      // typed into a plain text box looks like nothing to layer 1.
      const scanned = redactText(truncate(value, VALUE_LIMIT), conceal)
      states.push(`value="${scanned.text}"`)
    }
  }

  return states
}

function currentValue(el: Element): string {
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase()
    // Read, but never returned raw: classifySensitive() marks it and the caller masks it.
    // Returning '' here would lose the fact that the field is filled at all.
    if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') return ''
    return squash(el.value)
  }
  if (el instanceof HTMLTextAreaElement) return squash(el.value)
  if (el instanceof HTMLSelectElement) {
    return squash(el.selectedOptions[0]?.textContent ?? '')
  }
  return ''
}

/** Role for display, falling back to the tag name when the element has none. */
export function displayRole(el: Element): string {
  return roleOf(el) || el.tagName.toLowerCase()
}
