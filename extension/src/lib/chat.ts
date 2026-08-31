/**
 * Chat client, built on the official OpenAI SDK.
 *
 * The SDK speaks the dialect every provider in PROVIDERS accepts, so switching between
 * NVIDIA NIM, OpenRouter, Together, Groq and a local Ollama is a `baseURL` change.
 *
 * Two things the SDK does not cover, handled here:
 *   - `reasoning_content` is not part of the OpenAI schema, so the reasoning trace the
 *     Nemotron models return is read through a cast rather than a typed field.
 *   - Streaming tool calls arrive as `arguments` fragments that must be concatenated per
 *     index before they parse; the SDK yields raw deltas and leaves that to the caller.
 *
 * The exported surface is deliberately unchanged from the hand-rolled version, so agent.ts
 * and the panel are unaffected by what sits underneath.
 */

import OpenAI from 'openai'
import { anthropicChat, anthropicChatStream } from './anthropic'
import { geminiChat, geminiChatStream } from './gemini'
import type { ProviderConfig } from '../providers'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: Role
  content: string | ContentPart[]
  /** Present on assistant turns that called tools. */
  tool_calls?: ToolCall[]
  /** Required on tool results, matching the call being answered. */
  tool_call_id?: string
}

export interface ChatRequest {
  provider: ProviderConfig
  model: string
  messages: ChatMessage[]
  apiKey?: string
  tools?: unknown[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /**
   * Reasoning intensity, from the model's own supported set ('off', 'low', 'high', …).
   * Undefined leaves the provider default alone.
   */
  thinking?: string
  /** How this model expresses that control, from the catalogue. */
  thinkingFormat?: string
}

/**
 * Normalised reason a generation stopped, after Tau's StopReason. Providers spell these
 * differently — 'end_turn' and 'stop', 'max_tokens' and 'length' — so the loop should
 * never branch on a raw provider string.
 */
export type StopReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'abort'
  | 'error'

export function normaliseStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'length':
    case 'max_tokens':
    case 'model_length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_calls'
    case 'content_filter':
    case 'safety':
      return 'content_filter'
    case 'abort':
    case 'cancelled':
      return 'abort'
    case null:
    case undefined:
    case '':
      return 'stop'
    default:
      return 'error'
  }
}

export interface ChatResult {
  content: string
  /** The model's thinking trace, when it publishes one separately. Non-standard field. */
  reasoning: string
  toolCalls: ToolCall[]
  stopReason: StopReason
  usage?: { promptTokens?: number; completionTokens?: number }
}

export interface StreamHandlers {
  onContent?: (delta: string, whole: string) => void
  onReasoning?: (delta: string, whole: string) => void
  /** Fired once per tool call as soon as its name is known. */
  onToolCallStart?: (name: string, index: number) => void
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'ChatError'
  }
}

/**
 * `dangerouslyAllowBrowser` is required because the SDK refuses browser use by default, on
 * the assumption a key in a web page is a leaked key. Here it is the user's own credential,
 * held in chrome.storage for their own profile and never shipped in the bundle — so the
 * assumption does not hold. It would still be wrong on a public web page.
 */
function clientFor(provider: ProviderConfig, apiKey?: string): OpenAI {
  if (provider.requiresCredential && !apiKey) {
    throw new ChatError(`${provider.label} needs a credential (${provider.credentialName}).`, 0, '')
  }

  return new OpenAI({
    baseURL: provider.baseUrl,
    apiKey: apiKey ?? 'no-credential-required',
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  })
}

/**
 * Pull a usable status and message out of a provider error payload.
 *
 * Exported so it can be tested without constructing an SDK error, which needs a real
 * Response. The awkward case is streaming: a provider may answer HTTP 200 and then send
 * the failure as an SSE frame, so the SDK has no HTTP status to report while the payload
 * itself carries `"code": 500`. Reporting 0 there produced "returned 0" with raw JSON
 * appended, which told the user nothing.
 */
export function deriveFailure(
  status: number | undefined,
  payload: unknown,
): { status: number; detail: string } {
  if (typeof payload === 'string') {
    return { status: status ?? 0, detail: payload }
  }

  const object = (payload ?? {}) as { message?: unknown; code?: unknown; type?: unknown }
  const fromPayload = Number(object.code)
  const resolved = status ?? (Number.isFinite(fromPayload) ? fromPayload : 0)

  const message = typeof object.message === 'string' ? object.message : ''
  const type = typeof object.type === 'string' ? object.type : ''
  const detail = message || type || (Object.keys(object).length ? JSON.stringify(object) : '')

  return { status: resolved || 0, detail }
}

/** Map the SDK's error shape onto ours so callers need not know what is underneath. */
function toChatError(err: unknown, providerLabel: string): ChatError {
  if (err instanceof ChatError) return err

  if (err instanceof OpenAI.APIError) {
    const { status, detail } = deriveFailure(err.status, err.error)
    const label = status ? String(status) : 'an error'
    return new ChatError(`${providerLabel} returned ${label}`, status, detail.slice(0, 300))
  }

  return new ChatError(err instanceof Error ? err.message : String(err), 0, '')
}

type Params = Parameters<OpenAI['chat']['completions']['create']>[0]

/**
 * Reasoning controls are not part of the OpenAI schema, so each family spells them
 * differently. Tau's catalogue records which shape a model expects; these extra top-level
 * fields are forwarded verbatim by the SDK.
 */
export function thinkingParams(request: Pick<ChatRequest, 'thinking' | 'thinkingFormat'>): Record<string, unknown> {
  const level = request.thinking
  if (!level) return {}

  const enabled = level !== 'off'

  switch (request.thinkingFormat) {
    // A chat-template switch is boolean — it has no graded levels, so anything other than
    // 'off' simply means "think".
    case 'chat-template':
      return { chat_template_kwargs: { enable_thinking: enabled } }
    // Anthropic and Gemini both buy reasoning with a token budget inside their own request
    // bodies, so nothing belongs in the OpenAI-shaped params.
    case 'anthropic':
    case 'gemini':
      return {}
    case 'deepseek':
      return { chat_template_kwargs: { thinking: enabled } }
    case 'openrouter':
      return enabled ? { reasoning: { effort: level } } : { reasoning: { enabled: false } }
    // The plain shape. 'none' is what NVIDIA accepts for off — verified against the live
    // endpoint, where it took the reasoning trace from 111 characters to zero.
    default:
      return { reasoning_effort: enabled ? level : 'none' }
  }
}

function buildParams(request: ChatRequest, stream: boolean): Params {
  const { model, messages, tools, temperature, maxTokens } = request
  return {
    model,
    // Our ChatMessage is the wire shape; the SDK's union is narrower than we need for
    // image parts and tool results, so it is asserted rather than reconstructed.
    messages: messages as unknown as Params['messages'],
    stream,
    ...(tools?.length ? { tools: tools as Params['tools'], tool_choice: 'auto' as const } : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...thinkingParams(request),
  } as Params
}

/** Fields the OpenAI schema does not describe but these providers return. */
interface ReasoningBearing {
  reasoning_content?: string | null
}

/** One-shot: waits for the whole response. */
export async function chat(request: ChatRequest): Promise<ChatResult> {
  if (request.provider.dialect === 'anthropic') return anthropicChat(request)
  if (request.provider.dialect === 'gemini') return geminiChat(request)

  const client = clientFor(request.provider, request.apiKey)

  try {
    const completion = await client.chat.completions.create(buildParams(request, false), {
      signal: request.signal,
    })

    // Narrowed by stream:false, but the SDK's overload cannot see that through our builder.
    const choice = (completion as OpenAI.Chat.Completions.ChatCompletion).choices[0]
    const usage = (completion as OpenAI.Chat.Completions.ChatCompletion).usage

    return {
      content: choice?.message.content ?? '',
      reasoning: (choice?.message as ReasoningBearing | undefined)?.reasoning_content ?? '',
      toolCalls: (choice?.message.tool_calls ?? []) as ToolCall[],
      stopReason: normaliseStopReason(choice?.finish_reason),
      usage: {
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
      },
    }
  } catch (err: unknown) {
    throw toChatError(err, request.provider.label)
  }
}

/**
 * Streaming. Deltas arrive on three independent channels — prose, the reasoning trace, and
 * tool calls, whose `arguments` come as string fragments that must be concatenated per
 * index before they parse as JSON.
 */
export async function chatStream(
  request: ChatRequest,
  handlers: StreamHandlers = {},
): Promise<ChatResult> {
  if (request.provider.dialect === 'anthropic') return anthropicChatStream(request, handlers)
  if (request.provider.dialect === 'gemini') return geminiChatStream(request, handlers)

  const client = clientFor(request.provider, request.apiKey)

  let content = ''
  let reasoning = ''
  let finishReason: string | null = null
  let usage: ChatResult['usage']
  const partial = new Map<number, { id: string; name: string; args: string }>()
  const announced = new Set<number>()

  try {
    const stream = (await client.chat.completions.create(buildParams(request, true), {
      signal: request.signal,
    })) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        }
      }

      const choice = chunk.choices[0]
      if (!choice) continue
      if (choice.finish_reason) finishReason = choice.finish_reason

      const delta = choice.delta
      if (!delta) continue

      const trace = (delta as ReasoningBearing).reasoning_content
      if (trace) {
        reasoning += trace
        handlers.onReasoning?.(trace, reasoning)
      }

      if (delta.content) {
        content += delta.content
        handlers.onContent?.(delta.content, content)
      }

      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0
        const current = partial.get(index) ?? { id: '', name: '', args: '' }
        if (call.id) current.id = call.id
        if (call.function?.name) current.name = call.function.name
        if (call.function?.arguments) current.args += call.function.arguments
        partial.set(index, current)

        if (current.name && !announced.has(index)) {
          announced.add(index)
          handlers.onToolCallStart?.(current.name, index)
        }
      }
    }
  } catch (err: unknown) {
    throw toChatError(err, request.provider.label)
  }

  const toolCalls: ToolCall[] = [...partial.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id || `call_${index}`,
      type: 'function' as const,
      function: { name: call.name, arguments: call.args },
    }))

  return { content, reasoning, toolCalls, stopReason: normaliseStopReason(finishReason), usage }
}

/**
 * Build the user turn for one agent step.
 *
 * `imageDataUrl` is the screen capture. It must already be redacted — this function is the
 * last place the image is touched before it crosses the network, so anything unmasked
 * passed in here leaves the device.
 */
export function userTurn(observation: string, imageDataUrl?: string): ChatMessage {
  if (!imageDataUrl) return { role: 'user', content: observation }

  return {
    role: 'user',
    content: [
      { type: 'text', text: observation },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ],
  }
}

/** The result of a tool call, fed back so the model can continue. */
export function toolTurn(toolCallId: string, result: string): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content: result }
}
