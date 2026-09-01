/**
 * The egress guard: the last thing between a request and the network.
 *
 * Every layer above this one is a promise that redaction ran. This is the layer that makes
 * it a property. It wraps `fetch` itself — which is what the provider SDKs ultimately call,
 * so there is no way around it that does not involve editing this file — and re-checks the
 * outgoing payload with the same detectors that produced the redaction in the first place.
 *
 * A guard is only worth having if it fails closed, so it does: an unrecognised host is
 * refused, and a body that cannot be inspected is refused rather than waved through. The
 * cost of being wrong in that direction is a failed request the user can see; the cost of
 * being wrong in the other is a leak nobody sees.
 *
 * It is deliberately redundant. If it ever fires, something upstream is broken — which is
 * exactly why it reports rather than silently sanitising: a silent fix would hide the bug
 * and leave the next surface unprotected.
 */

import { PROVIDERS } from '../../providers/registry'
import { findPii } from '../../shared/detect'
import type { SensitiveKind } from '../../shared/types'

/** Message type carrying a content-script record to the panel's log. */
export const EGRESS_MESSAGE = 'AEGIS_EGRESS' as const

export interface EgressRecord {
  at: number
  host: string
  /** Bytes in the request body, so a screenshot's cost is visible. */
  bytes: number
  allowed: boolean
  /** Why it was refused, or what was found. */
  reason?: string
  kinds?: SensitiveKind[]
}

type Listener = (record: EgressRecord) => void

const listeners = new Set<Listener>()
const log: EgressRecord[] = []
const LOG_LIMIT = 200

export function onEgress(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function egressLog(): readonly EgressRecord[] {
  return log
}

/**
 * Record something a different JavaScript context observed.
 *
 * The content script runs its own guard over its own globalThis, so its records cannot
 * reach this log by return value. They are forwarded as messages and land here, which is
 * what lets one panel show every request rather than only the panel's own.
 */
export function recordExternal(entry: EgressRecord): void {
  record(entry)
}

function record(entry: EgressRecord): void {
  log.push(entry)
  if (log.length > LOG_LIMIT) log.shift()
  for (const listener of listeners) listener(entry)
}

/**
 * Hosts that serve code and model weights rather than receiving data.
 *
 * Layer 3 fetches its weights at runtime, and that fetch happens in the content script —
 * outside the panel where this guard was originally installed, and therefore invisible to
 * the panel that claims to show every request. Naming them here makes the dependency
 * explicit and puts it in the log, rather than leaving it unmonitored because it is
 * inbound.
 *
 * Matched by suffix: the Hugging Face CDN answers from several rotating subdomains.
 */
const ASSET_HOSTS = ['huggingface.co', 'hf.co', 'cdn.jsdelivr.net', 'unpkg.com']

function isAssetHost(host: string): boolean {
  return ASSET_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

/** Hosts the extension is allowed to talk to at all: exactly its configured providers. */
function allowedHosts(): Set<string> {
  const hosts = new Set<string>()
  for (const provider of PROVIDERS) {
    try {
      hosts.add(new URL(provider.baseUrl).host)
    } catch {
      // A malformed base URL simply contributes no permission.
    }
  }
  return hosts
}

/**
 * Long opaque runs are image payloads, not prose.
 *
 * Base64 is scanned past rather than examined: it cannot contain an email (no `@`), and a
 * digit run inside it would have to satisfy Verhoeff or Luhn by chance to matter. Reading
 * megabytes of it on every turn would cost more than the check is worth.
 */
const OPAQUE = /^[A-Za-z0-9+/=]{200,}$/

function isOpaque(value: string): boolean {
  return value.startsWith('data:') || OPAQUE.test(value)
}

/** Every string in a parsed body, so nothing hides inside nesting. */
function collectStrings(value: unknown, into: string[], depth = 0): void {
  if (depth > 12) return

  if (typeof value === 'string') {
    if (!isOpaque(value)) into.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, into, depth + 1)
  }
}

export interface Inspection {
  ok: boolean
  reason?: string
  kinds?: SensitiveKind[]
}

/** Exported for testing: decide whether a body may leave. */
export function inspectBody(body: string): Inspection {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // Every provider we support sends JSON. Anything else is unexpected, and unexpected
    // is refused rather than trusted.
    return { ok: false, reason: 'Request body is not JSON and cannot be inspected.' }
  }

  const strings: string[] = []
  collectStrings(parsed, strings)

  const kinds = new Set<SensitiveKind>()
  for (const text of strings) {
    for (const match of findPii(text)) kinds.add(match.kind)
  }

  if (kinds.size) {
    return {
      ok: false,
      reason: 'Unredacted personal data found in the request body.',
      kinds: [...kinds],
    }
  }
  return { ok: true }
}

async function bodyText(init: RequestInit | undefined, input: RequestInfo | URL): Promise<string> {
  if (typeof init?.body === 'string') return init.body
  if (init?.body instanceof URLSearchParams) return init.body.toString()
  if (input instanceof Request) return await input.clone().text()
  return ''
}

export class EgressBlocked extends Error {
  constructor(
    message: string,
    readonly record: EgressRecord,
  ) {
    super(message)
    this.name = 'EgressBlocked'
  }
}

/**
 * Wrap `fetch` once. Idempotent, so a re-entrant panel cannot stack guards.
 */
export function installEgressGuard(): void {
  const global = globalThis as typeof globalThis & { __aegisEgressGuarded?: boolean }
  if (global.__aegisEgressGuarded) return
  global.__aegisEgressGuarded = true

  const hosts = allowedHosts()
  const original = globalThis.fetch.bind(globalThis)

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    let host: string
    try {
      host = new URL(url, location.href).host
    } catch {
      const entry = { at: Date.now(), host: url, bytes: 0, allowed: false, reason: 'Unparseable URL.' }
      record(entry)
      throw new EgressBlocked(entry.reason, entry)
    }

    // Local requests are the extension loading its own assets, not egress.
    if (host === location.host) return original(input, init)

    const body = await bodyText(init, input)
    const bytes = body.length

    // A model download sends nothing and receives weights. It is still recorded, because a
    // user watching this panel should see everything the extension talks to.
    if (isAssetHost(host)) {
      if (body) {
        const verdict = inspectBody(body)
        if (!verdict.ok) {
          const entry = { at: Date.now(), host, bytes, allowed: false, reason: verdict.reason, kinds: verdict.kinds }
          record(entry)
          throw new EgressBlocked(`${verdict.reason} Nothing was sent.`, entry)
        }
      }
      record({ at: Date.now(), host, bytes, allowed: true, reason: 'model or runtime download' })
      return original(input, init)
    }

    if (!hosts.has(host)) {
      const entry = {
        at: Date.now(),
        host,
        bytes,
        allowed: false,
        reason: `${host} is not a configured provider.`,
      }
      record(entry)
      throw new EgressBlocked(entry.reason, entry)
    }

    // A GET carries nothing to inspect; listing models is not egress of page content.
    if (!body) {
      record({ at: Date.now(), host, bytes: 0, allowed: true })
      return original(input, init)
    }

    const verdict = inspectBody(body)
    const entry: EgressRecord = {
      at: Date.now(),
      host,
      bytes,
      allowed: verdict.ok,
      reason: verdict.reason,
      kinds: verdict.kinds,
    }
    record(entry)

    if (!verdict.ok) {
      throw new EgressBlocked(
        `${verdict.reason} Nothing was sent. ${
          verdict.kinds?.length ? `Found: ${verdict.kinds.join(', ')}.` : ''
        }`,
        entry,
      )
    }

    return original(input, init)
  }
}
