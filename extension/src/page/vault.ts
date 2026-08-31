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
 * Lifetime is the document's. A fresh navigation re-injects the content script and takes
 * the vault with it.
 */

import type { SensitiveKind } from './sensitive'

interface Entry {
  kind: SensitiveKind
  value: string
}

const byHandle = new Map<string, Entry>()
const byValue = new Map<string, string>()
let counter = 0

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
  if (existing) return wrap(existing)

  const handle = `${kind}#${++counter}`
  byValue.set(key, handle)
  byHandle.set(handle, { kind, value })
  return wrap(handle)
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

    if (!entry) {
      return {
        ok: false,
        error:
          `${token} is not a value from the current page — it may be from an earlier ` +
          'observation. Re-read the page and use the handle shown there.',
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
}
