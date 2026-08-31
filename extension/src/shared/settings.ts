/**
 * Provider selection and credentials, held in chrome.storage.local.
 *
 * Not in the build, and not in the repository. Storage is per browser profile and is not
 * encrypted — anyone with access to the profile directory can read it — but it never
 * ships inside the extension package, which a `.env` inlined by Vite would.
 *
 * On a server the same values come from the environment; `chat()` takes the credential as
 * a parameter precisely so neither side has to care where the other got it.
 */

import { MODELS, PROVIDERS, getProvider, hasVision, thinkingLevelsFor } from '../providers/registry'
import type { ModelConfig, ProviderConfig } from '../providers/registry'

const SETTINGS_KEY = 'aegis.settings'
const CREDENTIAL_PREFIX = 'aegis.credential.'

export interface Settings {
  providerId: string
  modelId: string
  /**
   * Reasoning intensity, chosen from the model's own supported set. Defaults to 'off'
   * because one observed turn spent 49 seconds thinking before its first action; with
   * reasoning off the same task took 2 seconds.
   */
  thinkingLevel: string
  /**
   * What the model is shown each turn. 'tree' is text-only and sends no pixels; the
   * screenshot modes do, which is exactly the visual context SIH26171 requires to be
   * redacted first — so they carry a warning until the cascade exists.
   */
  observationMode: ObservationMode
}

export type ObservationMode = 'tree' | 'screenshot' | 'both'

/** Local by default: nothing leaves the machine until the user opts into a hosted one. */
const DEFAULTS: Settings = { providerId: 'ollama', modelId: 'qwen2.5vl:7b', thinkingLevel: 'off', observationMode: 'tree' }

export async function getSettings(): Promise<Settings> {
  const raw = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as
    | (Partial<Settings> & { thinkingOff?: boolean })
    | undefined

  const settings = { ...DEFAULTS, ...raw }

  // Carry over the earlier boolean toggle so an existing profile keeps its preference.
  if (raw?.thinkingLevel === undefined && raw?.thinkingOff !== undefined) {
    settings.thinkingLevel = raw.thinkingOff ? 'off' : 'high'
  }

  return settings
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ [SETTINGS_KEY]: next })
  return next
}

export async function getCredential(providerId: string): Promise<string | undefined> {
  const key = CREDENTIAL_PREFIX + providerId
  const stored = await chrome.storage.local.get(key)
  const value = stored[key]
  return typeof value === 'string' && value ? value : undefined
}

export async function setCredential(providerId: string, value: string): Promise<void> {
  await chrome.storage.local.set({ [CREDENTIAL_PREFIX + providerId]: value })
}

export async function clearCredential(providerId: string): Promise<void> {
  await chrome.storage.local.remove(CREDENTIAL_PREFIX + providerId)
}

/** Enough to recognise a key, not enough to use it. */
export function maskCredential(value: string): string {
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

export interface ResolvedTarget {
  provider: ProviderConfig
  model: ModelConfig
  apiKey?: string
  /** Set when the model can suppress reasoning and the user asked for that. */
  thinking?: string
  /** Resolved mode — downgraded to 'tree' when the model cannot accept images. */
  observationMode: ObservationMode
}

/**
 * Everything a chat call needs, or an explanation of what is missing. Resolving in one
 * place keeps the "which provider, which model, which key" question out of the agent loop.
 */
export async function resolveTarget(): Promise<ResolvedTarget | { error: string }> {
  const settings = await getSettings()

  const provider = getProvider(settings.providerId)
  if (!provider) {
    return {
      error:
        `Unknown provider ${JSON.stringify(settings.providerId)}. Known: ` +
        `${PROVIDERS.map((p) => p.id).join(', ')}.`,
    }
  }

  const model =
    MODELS.find((m) => m.provider === provider.id && m.id === settings.modelId) ??
    // An id typed by hand is allowed — the registry is defaults, not an allowlist.
    ({
      provider: provider.id,
      id: settings.modelId,
      label: settings.modelId,
      // A hand-typed id has no catalogue entry, so assume the richer capability and let
      // the provider reject it rather than silently downgrading the request.
      input: ['text', 'image'],
      output: ['text'],
      tools: true,
    } satisfies ModelConfig)

  // Only send a level the model actually lists; otherwise leave the provider default be.
  const supported = thinkingLevelsFor(model)
  const thinking = supported.includes(settings.thinkingLevel)
    ? settings.thinkingLevel
    : undefined

  // A model that cannot take images gets the tree whatever the setting says.
  const observationMode: ObservationMode = hasVision(model) ? settings.observationMode : 'tree'

  if (!provider.requiresCredential) {
    return { provider, model, thinking, observationMode }
  }

  const apiKey = await getCredential(provider.id)
  if (!apiKey) {
    return {
      error:
        `${provider.label} needs a credential. Set one with:  key ${provider.id} <value>\n` +
        `On a server this would come from ${provider.credentialName}.`,
    }
  }

  return { provider, model, apiKey, thinking, observationMode }
}
