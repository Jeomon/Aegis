/**
 * Provider registry.
 *
 * Most providers here speak the OpenAI chat-completions dialect, so switching is a
 * `baseUrl` and a model string — nothing downstream changes. New providers are added by
 * appending to PROVIDERS, not by touching the client.
 *
 * The model list lives in models.generated.ts, extracted from Tau's curated catalogue and
 * filtered to models that accept image input.
 *
 * Note for the submission: SIH26171 asks for an offline-deployable (open-weights) server
 * model, a hosted copy being acceptable during the event. That is no longer enforced here,
 * so whoever picks the model is responsible for checking it.
 */

import { CATALOGUE } from './models.generated'

export type Dialect = 'openai' | 'anthropic' | 'gemini'

export interface ProviderConfig {
  id: string
  label: string
  baseUrl: string
  dialect: Dialect
  /**
   * Where the credential is read from — an env var on a server, a storage key in the
   * extension. Never the key itself.
   */
  credentialName: string
  /** Local runtimes need no credential. */
  requiresCredential: boolean
  /** Free-form note for the UI: rate limits, sign-up friction. */
  note?: string
}

export interface ModelConfig {
  /** Provider id this belongs to. */
  provider: string
  /** The string sent as `model` in the request. */
  id: string
  label: string
  /** Modalities the model accepts, normalised to text, image, audio, video, file. */
  input: readonly string[]
  /** Modalities it produces. Almost always text for our purposes. */
  output: readonly string[]
  /** Supports function/tool calling. */
  tools: boolean
  /** Actually called against the live endpoint, rather than taken from a catalogue page. */
  verified?: boolean
  /** Reasoning settings the model accepts. Containing 'off' means it can be disabled. */
  thinkingLevels?: readonly string[]
  /** How the reasoning control is expressed on the wire. */
  thinkingFormat?: string
  /** Context window in tokens. */
  context?: number
}

export const PROVIDERS: readonly ProviderConfig[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    // No /v1 here: the Anthropic SDK appends /v1/messages itself, unlike the OpenAI SDK
    // which treats baseURL as the full prefix.
    baseUrl: 'https://api.anthropic.com',
    dialect: 'anthropic',
    credentialName: 'ANTHROPIC_API_KEY',
    requiresCredential: true,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    // The Gen AI SDK targets Google's endpoint itself; this is recorded for reference only.
    baseUrl: 'https://generativelanguage.googleapis.com',
    dialect: 'gemini',
    credentialName: 'GEMINI_API_KEY',
    requiresCredential: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    dialect: 'openai',
    credentialName: 'OPENAI_API_KEY',
    requiresCredential: true,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    dialect: 'openai',
    credentialName: 'NVIDIA_API_KEY',
    requiresCredential: true,
    note: 'Free tier for Developer Program members. Shared capacity — can return ResourceExhausted when busy.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    dialect: 'openai',
    credentialName: 'OPENROUTER_API_KEY',
    requiresCredential: true,
    note: 'Broadest catalogue; mixes open and closed models, so the open-weights filter matters most here.',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    dialect: 'openai',
    credentialName: 'TOGETHER_API_KEY',
    requiresCredential: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    dialect: 'openai',
    credentialName: 'GROQ_API_KEY',
    requiresCredential: true,
    note: 'Fastest for text; vision coverage is narrow.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    dialect: 'openai',
    credentialName: 'MISTRAL_API_KEY',
    requiresCredential: true,
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    dialect: 'openai',
    credentialName: 'CEREBRAS_API_KEY',
    requiresCredential: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    dialect: 'openai',
    credentialName: '',
    requiresCredential: false,
    note:
      'A model you pulled locally keeps everything on the machine. Models tagged :cloud ' +
      'are Ollama-hosted and do leave it — the catalogue below is mostly those.',
  },
  {
    id: 'vllm',
    label: 'vLLM (self-hosted)',
    baseUrl: 'http://127.0.0.1:8000/v1',
    dialect: 'openai',
    credentialName: '',
    requiresCredential: false,
    note: 'Serve any open-weights checkpoint yourself; proves the offline claim outright.',
  },
]

/** Models we have actually called, as opposed to read from a catalogue. */
const VERIFIED: Record<string, true> = {
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': true,
}

/**
 * Corrections to the generated catalogue. Muse Glimmer timed out at 90s when I first
 * attached tools, which I read as "no tool support" — it is slow with them, not incapable.
 */
const OVERRIDES: Record<string, Partial<ModelConfig>> = {
  // Timed out at 90s when tools were first attached, which I misread as no tool support.
  // It is slow with them, not incapable.
  'meta/muse-glimmer-30b': { tools: true },
}

export const MODELS: readonly ModelConfig[] = CATALOGUE.map((model) => ({
  ...model,
  ...OVERRIDES[model.id],
  ...(VERIFIED[model.id] ? { verified: true } : {}),
}))

export function getProvider(id: string): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

export function modelsFor(providerId: string): ModelConfig[] {
  return MODELS.filter((m) => m.provider === providerId)
}

/** Models this provider offers that the agent can actually drive. */
export function eligibleModelsFor(providerId: string): ModelConfig[] {
  return modelsFor(providerId).filter((m) => checkUsable(m).ok)
}

/** Whether reasoning can be switched off — the difference between 2s and 8s per turn. */
export function canDisableThinking(model: ModelConfig): boolean {
  return (model.thinkingLevels ?? []).includes('off')
}

/** Can this model be shown a screenshot at all? */
export function hasVision(model: ModelConfig | undefined): boolean {
  return model?.input.includes('image') ?? false
}

/** A short 'text · image · video' summary for the UI. */
export function describeModalities(model: ModelConfig): string {
  return model.input.join(' · ')
}

/** The reasoning settings this model accepts, cheapest first. Empty means no control. */
export function thinkingLevelsFor(model: ModelConfig | undefined): readonly string[] {
  return model?.thinkingLevels ?? []
}

/**
 * Reject a model the agent cannot drive. Only tool calling is genuinely required — without
 * it nothing can be clicked. Image input is not: in tree mode no screenshot is sent, so a
 * text-only model works, and the observation mode downgrades automatically for it.
 */
export function checkUsable(model: ModelConfig): { ok: boolean; reason?: string } {
  if (!model.tools) {
    return {
      ok: false,
      reason: `${model.label} cannot call tools, so it cannot drive the browser.`,
    }
  }
  return { ok: true }
}
