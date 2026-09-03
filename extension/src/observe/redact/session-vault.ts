/**
 * The panel's own vault, for values that never came from a page.
 *
 * Two sources reach the model without passing through the content script, and both were
 * going out in the clear. The user's own message — "my Aadhaar is 2345 6789 0124, fill it
 * in" — and tool results, which echo tab titles, URLs and whatever `evaluate` returned.
 *
 * Both are worse than a plain leak, because the egress guard fails closed: an unredacted
 * identifier in either does not quietly escape, it blocks the request and the turn dies.
 * A user who types their own ID number would simply find the agent broken.
 *
 * So these are concealed here, in the side panel, under their own namespace. The value goes
 * no further than this module: not into `history`, not into the transcript the model reads,
 * and never onto the network — the guard sees only the handle.
 *
 * Kept separate from the page vault deliberately. That one lives in the content script so a
 * page's secrets never leave their tab; this one holds values the page never had. Distinct
 * namespaces mean a handle from one can never be redeemed against the other.
 */

import { redactText } from '../../shared/detect'
import type { SensitiveKind } from '../../shared/types'

interface Entry {
  kind: SensitiveKind
  value: string
}

const byHandle = new Map<string, Entry>()
const byValue = new Map<string, string>()
let counter = 0

/** `s` for session: distinct from the page's frame tags (empty, f1-, f1-1-). */
const TAG = 's'

/**
 * The `s` is optional when reading.
 *
 * A model reproducing a handle is copying a token out of prose, and it drops the tag often
 * enough to matter: asked to type `[redacted:email#s1]` it emits `[redacted:email#1]`. A
 * strict pattern leaves that unmatched, and the literal text lands in the field — the exact
 * failure this vault exists to prevent, made worse by looking like it worked.
 *
 * Reading loosely is safe because the lookup still has to hit: a number with no session
 * entry falls through untouched, and the page's own vault gets its turn.
 */
export const SESSION_HANDLE_PATTERN = /\[redacted:([a-z-]+)#s?(\d+)\]/g

function conceal(kind: SensitiveKind, value: string): string {
  const key = `${kind}\u0000${value}`
  const existing = byValue.get(key)
  if (existing) return `[redacted:${existing}]`

  const handle = `${kind}#${TAG}${++counter}`
  byValue.set(key, handle)
  byHandle.set(handle, { kind, value })
  return `[redacted:${handle}]`
}

/**
 * Replace identifiers in text the panel is about to record or send.
 *
 * Returns the text to show and store. The displayed message is the redacted one on purpose:
 * what the user sees in the transcript should be what the model sees, or the interface is
 * lying about what left the device.
 */
export function concealForSession(text: string): string {
  return redactText(text, conceal).text
}

export interface Restored {
  text: string
  kinds: SensitiveKind[]
}

/**
 * Expand session handles just before an action is dispatched to the page.
 *
 * The page's own vault cannot resolve these — it never saw the value — so the panel expands
 * its own and passes the kind alongside, letting the page enforce the same rule it applies
 * to its own handles: a value only ever enters a field of its own kind.
 */
export function restoreForAction(text: string): Restored {
  const kinds: SensitiveKind[] = []
  const out = text.replace(SESSION_HANDLE_PATTERN, (token, _kind: string, id: string) => {
    // Minted with the tag, read with or without it: the pattern makes the `s` optional, so
    // the digits arrive bare and the tag has to go back on for the lookup.
    const entry = byHandle.get(`${_kind}#${TAG}${id}`)
    if (!entry) return token
    kinds.push(entry.kind)
    return entry.value
  })
  return { text: out, kinds }
}

/** Test seam; the vault otherwise lives as long as the panel does. */
export function resetSessionVault(): void {
  byHandle.clear()
  byValue.clear()
  counter = 0
}
