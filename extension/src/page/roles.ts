/**
 * Role vocabulary and implicit-role mapping.
 *
 * Ported from the browser_use DOM service, which reads roles out of CDP's
 * Accessibility.getFullAXTree. A content script has no access to that, so implicit roles
 * are derived from tag and type here instead.
 */

/** Roles that denote something a user can operate. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'checkbox', 'radio', 'textbox', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'treeitem',
  'slider', 'spinbutton', 'searchbox', 'switch', 'gridcell',
  'columnheader', 'rowheader',
  'tooltip', 'tree', 'tabpanel', 'progressbar', 'scrollbar',
])

/** Tags that are interactive by nature. */
export const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'option',
  'summary', 'menu', 'menuitem',
  'embed', 'canvas', 'object',
])

/** Interactive in its own right, rather than by an inherited signal. */
export const STRONG_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'summary', 'option',
])

/** Never worth walking into. */
export const EXCLUDED_TAGS: ReadonlySet<string> = new Set([
  'style', 'script', 'noscript', 'link', 'meta', 'head', 'br', 'hr', 'template',
])

/** Inline tags whose text belongs to their parent's accessible name. */
export const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  'span', 'em', 'strong', 'b', 'i', 'small', 'abbr', 'code',
  'mark', 'sub', 'sup', 'cite', 'q', 'u', 's', 'del', 'ins',
  'time', 'kbd', 'var', 'samp', 'a',
])

const SEARCH_INDICATORS = [
  'search', 'magnify', 'glass', 'lookup', 'find', 'query',
  'search-icon', 'search-btn', 'search-button', 'searchbox',
]

/**
 * A search affordance signalled by class/id/data-* keywords — catches nameless
 * search-icon buttons that carry no tag or role of their own.
 */
export function hasSearchIndicator(el: Element): boolean {
  const className = typeof el.className === 'string' ? el.className.toLowerCase() : ''
  if (SEARCH_INDICATORS.some((word) => className.includes(word))) return true
  if (SEARCH_INDICATORS.some((word) => el.id.toLowerCase().includes(word))) return true

  for (const attr of el.attributes) {
    if (!attr.name.startsWith('data-')) continue
    const value = attr.value.toLowerCase()
    if (SEARCH_INDICATORS.some((word) => value.includes(word))) return true
  }
  return false
}

/** input types that behave as a text field. */
const TEXTUAL_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text', 'email', 'tel', 'url', 'password', 'date', 'datetime-local',
  'month', 'week', 'time',
])

const BUTTON_INPUT_TYPES: ReadonlySet<string> = new Set([
  'submit', 'button', 'reset', 'image',
])

/**
 * The element's role: an explicit `role` attribute wins, otherwise the implicit role
 * implied by tag and type. Returns '' when the element has no meaningful role.
 */
export function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')?.trim().toLowerCase()
  if (explicit) return explicit.split(/\s+/)[0]

  const tag = el.tagName.toLowerCase()

  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase()
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'range') return 'slider'
    if (type === 'number') return 'spinbutton'
    if (type === 'search') return 'searchbox'
    if (BUTTON_INPUT_TYPES.has(type)) return 'button'
    if (TEXTUAL_INPUT_TYPES.has(type)) return 'textbox'
    return 'textbox'
  }

  if (el instanceof HTMLSelectElement) {
    return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
  }

  switch (tag) {
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : ''
    case 'button':
      return 'button'
    case 'textarea':
      return 'textbox'
    case 'option':
      return 'option'
    case 'summary':
      return 'button'
    case 'progress':
      return 'progressbar'
    case 'dialog':
      return 'dialog'
    case 'form':
      return 'form'
    case 'nav':
      return 'navigation'
    case 'main':
      return 'main'
    case 'img':
      return el.getAttribute('alt') === '' ? 'presentation' : 'img'
    default:
      return ''
  }
}
