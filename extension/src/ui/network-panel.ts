/**
 * Every outbound request, as it happens.
 *
 * The rest of the extension asks to be trusted: layers of redaction, a vault, a guard. This
 * panel is the one place a user can check rather than trust — it shows what left, how big
 * it was, and what was refused, from the guard's own log rather than a parallel account of
 * it. If the two could disagree, this would be decoration.
 *
 * A refusal also lights the toggle, because the whole point is that it should be noticed
 * without the panel being open.
 */

import { egressLog, onEgress, type EgressRecord } from '../observe/redact/egress'

const toggleEl = document.querySelector<HTMLButtonElement>('#networkToggle')!
const dotEl = document.querySelector<HTMLSpanElement>('#networkDot')!
const panelEl = document.querySelector<HTMLElement>('#network')!
const listEl = document.querySelector<HTMLElement>('#netList')!
const emptyEl = document.querySelector<HTMLElement>('#netEmpty')!
const summaryEl = document.querySelector<HTMLElement>('#netSummary')!

/** Bytes, but readable at a glance — a screenshot turn is visibly larger than a text one. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Built as nodes rather than markup. The host comes from a URL the model may have chosen,
 * and this panel exists to be believed — assigning innerHTML here would be the one place an
 * injected string could reach the panel's own DOM.
 */
function row(record: EgressRecord): HTMLElement {
  const el = document.createElement('div')
  el.className = `net ${record.allowed ? 'sent' : 'blocked'}`

  const mark = document.createElement('span')
  mark.className = 'mark'
  mark.textContent = record.allowed ? '↑' : '✕'

  const host = document.createElement('span')
  host.className = 'host'
  host.textContent = record.host

  const bytes = document.createElement('span')
  bytes.className = 'size'
  bytes.textContent = record.bytes ? size(record.bytes) : '—'

  el.append(mark, host, bytes)

  if (!record.allowed && record.reason) {
    const why = document.createElement('span')
    why.className = 'why'
    why.textContent = record.kinds?.length
      ? `${record.reason} Found: ${record.kinds.join(', ')}.`
      : record.reason
    el.append(why)
  }

  return el
}

function summarise(): void {
  const log = egressLog()
  const blocked = log.filter((r) => !r.allowed).length
  const sent = log.length - blocked
  const bytes = log.reduce((total, r) => (r.allowed ? total + r.bytes : total), 0)

  summaryEl.textContent = log.length
    ? `${sent} sent · ${size(bytes)}${blocked ? ` · ${blocked} refused` : ''}`
    : ''
  emptyEl.hidden = log.length > 0
}

function add(record: EgressRecord): void {
  // Newest first: during a turn the interesting line is the one that just appeared.
  listEl.prepend(row(record))
  summarise()

  dotEl.classList.toggle('blocked', !record.allowed)
  dotEl.classList.toggle('sent', record.allowed)

  // A refusal is worth opening the panel for on its own — it means a layer upstream let
  // something through, which is exactly the case a user should not have to go looking for.
  if (!record.allowed) setOpen(true)
}

// Tracked rather than read back from the element: `hidden` is typed string | boolean since
// hidden="until-found" landed, and this is a plain two-state toggle.
let open = false

function setOpen(next: boolean): void {
  open = next
  panelEl.hidden = !open
  toggleEl.setAttribute('aria-expanded', String(open))
}

export function mountNetworkPanel(): void {
  for (const record of egressLog()) listEl.prepend(row(record))
  summarise()

  toggleEl.addEventListener('click', () => setOpen(!open))
  onEgress(add)
}
