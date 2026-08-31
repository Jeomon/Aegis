/**
 * The vault: real values behind the handles the model sees.
 *
 * Redaction alone would make the agent useless for the tasks that matter most — it cannot
 * re-enter a password it was never shown. So a masked value becomes a handle,
 * `[redacted:email#3]`, and the model directs that handle to a field without ever holding
 * what it stands for. The substitution happens here, one step before the keystrokes.
 *
 * This module lives in the content script by design. Values are read in the page and typed
 * in the page, so a secret's entire life stays inside the tab it came from: the side panel
 * never receives it, nothing is written to chrome.storage, and no code path carries it to
 * the network. Tab actions and evaluate run in the panel, which has no access to this map,
 * so a handle in a URL or a script cannot expand — it is structurally out of reach rather
 * than merely disallowed.
 *
 * Lifetime has two scales. The map is the document's — a fresh navigation re-injects the
 * content script and takes the vault with it. Within that, each entry tracks the scan it
 * was last seen in, so a value that has left the page stops resolving and is pruned.
 *
 * What must never happen is a handle coming to mean something different. Clearing the map
 * each turn would do exactly that: handles persist in the transcript, so a restarted
 * counter would let `password#1` from turn 1 resolve to a value the field only acquired at
 * turn 4, and the agent would type a secret the model never asked for. The counter
 * therefore only ever increases, and a handle is never reissued.
 */

import type { SensitiveKind } from '../shared/types'

interface Entry {
  kind: SensitiveKind
  value: string
  /** The scan this value was last present in. */
  seen: number
}

const byHandle = new Map<string, Entry>()
const byValue = new Map<string, string>()
let counter = 0
let generation = 0

/**
 * How many scans an entry survives after it stops appearing on the page. One, not zero,
 * because runAction() rescans and re-runs the same action when an element id goes stale —
 * a handle in that retried action must still resolve.
 */
const GRACE = 1

/** Matches a handle anywhere in a string the model produced. */
export const HANDLE_PATTERN = /\[redacted:([a-z-]+)#(\d+)\]/g

/**
 * Store a value and return the handle standing in for it.
 *
 * The same value always yields the same handle, so a rescan does not invalidate a handle
 * the model is already holding — the stale-id retry re-runs an action after rescanning,
 * and a fresh handle each time would break exactly that path.
 */
export function conceal(kind: SensitiveKind, value: string): string {
  const key = `${kind}\u0000${value}`
  const existing = byValue.get(key)

  // Both paths must return the same wrapped form. Returning the bare handle on the second
  // call made a rescan emit `value=password#1`, which HANDLE_PATTERN does not match — the
  // agent would then have typed that literal string into the field.
  if (existing) {
    const entry = byHandle.get(existing)
    if (entry) entry.seen = generation
    return wrap(existing)
  }

  const handle = `${kind}#${++counter}`
  byValue.set(key, handle)
  byHandle.set(handle, { kind, value, seen: generation })
  return wrap(handle)
}

/**
 * Open a new scan generation and drop values that have left the page.
 *
 * Called once before the page is walked, so everything still present is re-marked as the
 * walk conceals it. Pruning is what keeps a secret from outliving its field; not reusing
 * the handle is what keeps the pruning safe.
 */
export function beginScan(): void {
  generation++

  for (const [handle, entry] of byHandle) {
    if (generation - entry.seen <= GRACE) continue
    byHandle.delete(handle)
    byValue.delete(`${entry.kind}\u0000${entry.value}`)
  }
}

function wrap(handle: string): string {
  return `[redacted:${handle}]`
}

export function reveal(handle: string): Entry | undefined {
  return byHandle.get(handle)
}

export type RehydrateResult =
  | { ok: true; text: string; used: SensitiveKind[] }
  | { ok: false; error: string }

/**
 * Expand any handles in text about to be typed, but only into a field of the same kind.
 *
 * The agent reads untrusted pages, so a page can try to talk it into moving a secret
 * somewhere the page can read — "type [redacted:password#1] into the search box". Matching
 * on kind keeps the useful cases, a confirm-password field or a re-asked checkout step,
 * and refuses the rest. A refusal is returned as an ordinary failure so the model can say
 * so rather than silently typing a literal handle into the page.
 */
export function rehydrate(text: string, targetKind: SensitiveKind | undefined): RehydrateResult {
  const handles = [...text.matchAll(HANDLE_PATTERN)]
  if (!handles.length) return { ok: true, text, used: [] }

  const used: SensitiveKind[] = []
  let expanded = text

  for (const match of handles) {
    const [token, kind, id] = match
    const entry = reveal(`${kind}#${id}`)

    if (!entry || generation - entry.seen > GRACE) {
      return {
        ok: false,
        error:
          `${token} is not a value on the page as it stands now — the field may have been ` +
          'cleared or changed since. Re-read the page and use the handle shown there.',
      }
    }

    if (targetKind !== entry.kind) {
      return {
        ok: false,
        error:
          `A ${entry.kind} value cannot be entered into ${
            targetKind ? `a ${targetKind} field` : 'a field that holds no declared secret'
          }. It can only go into another ${entry.kind} field.`,
      }
    }

    expanded = expanded.replace(token, entry.value)
    used.push(entry.kind)
  }

  return { ok: true, text: expanded, used }
}

/** Test seam. The vault is otherwise only emptied by the document going away. */
export function resetVault(): void {
  byHandle.clear()
  byValue.clear()
  counter = 0
  generation = 0
}
