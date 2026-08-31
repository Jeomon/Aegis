/**
 * The Anthropic Messages dialect, on Anthropic's own SDK.
 *
 * Everything else Aegis talks to speaks OpenAI chat-completions, carried by the OpenAI SDK.
 * Anthropic does not: the system prompt is a top-level parameter rather than a message,
 * tool schemas sit under `input_schema`, tool results are content blocks on a user turn
 * rather than a `tool` role, and the stream is typed events instead of choice deltas.
 *
 * The SDK owns transport, retries and stream decoding. What remains here is the conversion
 * in both directions, so the agent loop cannot tell which provider answered.
 */

import Anthropic from '@anthropic-ai/sdk'

import type { ChatMessage, ChatRequest, ChatResult, StreamHandlers, ToolCall } from './chat'
import { ChatError, normaliseStopReason } from './chat'

/** Anthropic requires max_tokens; there is no "as much as needed" default. */
const DEFAULT_MAX_TOKENS = 4096

// ---------------------------------------------------------------------------------------
// Request conversion
// ---------------------------------------------------------------------------------------

type Block = Anthropic.ContentBlockParam
type AnthropicMessage = Anthropic.MessageParam

/**
 * Split a data URL into the media type and payload the API wants. Screenshots arrive as
 * `data:image/png;base64,…` from chrome.tabs.captureVisibleTab.
 */
function imageBlock(dataUrl: string): Block | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) return undefined

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1] as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      data: match[2],
    },
  }
}

function contentBlocks(content: ChatMessage['content']): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []

  const blocks: Block[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text })
    } else {
      const image = imageBlock(part.image_url.url)
      if (image) blocks.push(image)
    }
  }
  return blocks
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Convert our OpenAI-shaped history.
 *
 * Three structural differences are handled here. The system prompt is hoisted out of the
 * message list. Tool results become `tool_result` blocks on a *user* message, because the
 * `tool` role does not exist. And roles must strictly alternate, so consecutive same-role
 * messages are merged — the loop naturally emits several tool results in a row.
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string
  messages: AnthropicMessage[]
} {
  const system: string[] = []
  const converted: AnthropicMessage[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string' ? message.content : ''
      if (text) system.push(text)
      continue
    }

    let role: 'user' | 'assistant'
    let blocks: Block[]

    if (message.role === 'tool') {
      role = 'user'
      blocks = [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id ?? '',
          content: typeof message.content === 'string' ? message.content : '',
        },
      ]
    } else {
      role = message.role
      blocks = contentBlocks(message.content)
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          // Arguments cross our wire as a JSON string, but Anthropic wants the object.
          input: parseArguments(call.function.arguments),
        })
      }
    }

    if (!blocks.length) continue

    const previous = converted[converted.length - 1]
    if (previous?.role === role) (previous.content as Block[]).push(...blocks)
    else converted.push({ role, content: blocks })
  }

  return { system: system.join('\n\n'), messages: converted }
}

/** OpenAI nests the schema under `function`; Anthropic puts it flat under `input_schema`. */
export function toAnthropicTools(tools: unknown[] | undefined): Anthropic.ToolUnion[] | undefined {
  if (!tools?.length) return undefined

  return tools.map((tool) => {
    const fn = (tool as { function?: { name?: string; description?: string; parameters?: unknown } })
      .function
    return {
      name: fn?.name ?? '',
      description: fn?.description ?? '',
      input_schema: (fn?.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema,
    }
  })
}

/**
 * Anthropic buys reasoning with a token budget rather than an effort label. The budget is
 * drawn from max_tokens, so max_tokens has to be raised to leave room for an answer.
 */
export function thinkingBudget(level: string | undefined): number | undefined {
  switch (level) {
    case 'minimal':
      return 1024
    case 'low':
      return 2048
    case 'medium':
      return 4096
    case 'high':
      return 8192
    case 'xhigh':
      return 16384
    case 'max':
      return 32768
    // undefined, 'off', or a label from another family: leave thinking disabled.
    default:
      return undefined
  }
}

export function buildAnthropicBody(
  request: ChatRequest,
): Omit<Anthropic.MessageCreateParams, 'stream'> {
  const { system, messages } = toAnthropicMessages(request.messages)
  const budget = thinkingBudget(request.thinking)
  const tools = toAnthropicTools(request.tools)

  return {
    model: request.model,
    max_tokens: Math.max(request.maxTokens ?? DEFAULT_MAX_TOKENS, budget ? budget + 1024 : 0),
    ...(system ? { system } : {}),
    messages,
    ...(tools ? { tools } : {}),
    // Extended thinking requires the default temperature, so the two are mutually exclusive.
    ...(budget
      ? { thinking: { type: 'enabled' as const, budget_tokens: budget } }
      : request.temperature === undefined
        ? {}
        : { temperature: request.temperature }),
  }
}

// ---------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------

/**
 * `dangerouslyAllowBrowser` also makes the SDK send the header Anthropic requires for
 * browser-origin calls. The guard exists because a key in a public page is a leaked key;
 * here it is the user's own credential in chrome.storage, never bundled.
 */
function clientFor(request: ChatRequest): Anthropic {
  if (!request.apiKey) {
    throw new ChatError(
      `${request.provider.label} needs a credential (${request.provider.credentialName}).`,
      0,
      '',
    )
  }

  return new Anthropic({
    apiKey: request.apiKey,
    baseURL: request.provider.baseUrl,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  })
}

function toChatError(err: unknown, providerLabel: string): ChatError {
  if (err instanceof Anthropic.APIError) {
    return new ChatError(err.message, err.status ?? 0, JSON.stringify(err.error ?? {}))
  }
  if (err instanceof ChatError) return err
  return new ChatError(`${providerLabel}: ${(err as Error).message}`, 0, '')
}

// ---------------------------------------------------------------------------------------
// Response conversion
// ---------------------------------------------------------------------------------------

export function fromAnthropicMessage(message: Anthropic.Message): ChatResult {
  let content = ''
  let reasoning = ''
  const toolCalls: ToolCall[] = []

  for (const block of message.content) {
    if (block.type === 'text') content += block.text
    else if (block.type === 'thinking') reasoning += block.thinking
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }

  return {
    content,
    reasoning,
    toolCalls,
    stopReason: normaliseStopReason(message.stop_reason),
    usage: {
      promptTokens: message.usage?.input_tokens,
      completionTokens: message.usage?.output_tokens,
    },
  }
}

export async function anthropicChat(request: ChatRequest): Promise<ChatResult> {
  const client = clientFor(request)
  try {
    const message = await client.messages.create(
      { ...buildAnthropicBody(request), stream: false },
      { signal: request.signal },
    )
    return fromAnthropicMessage(message)
  } catch (err: unknown) {
    throw toChatError(err, request.provider.label)
  }
}

/**
 * Streaming. A tool call is opened by `content_block_start` carrying its id and name, then
 * filled by `input_json_delta` fragments that only parse once concatenated — the same
 * reassembly the OpenAI path performs, keyed here by block index rather than call index.
 */
export async function anthropicChatStream(
  request: ChatRequest,
  handlers: StreamHandlers = {},
): Promise<ChatResult> {
  const client = clientFor(request)

  let content = ''
  let reasoning = ''
  let stopReason: string | null = null
  let usage: ChatResult['usage']
  const blocks = new Map<number, { id: string; name: string; args: string }>()

  try {
    // Spreading the body widens `stream` past the literal the streaming overload keys on,
    // so the iterable is asserted — the same accommodation the OpenAI path makes.
    const stream = (await client.messages.create(
      { ...buildAnthropicBody(request), stream: true },
      { signal: request.signal },
    )) as unknown as AsyncIterable<Anthropic.MessageStreamEvent>

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          usage = { promptTokens: event.message.usage?.input_tokens }
          break

        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            blocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              args: '',
            })
            handlers.onToolCallStart?.(event.content_block.name, event.index)
          }
          break

        case 'content_block_delta': {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            content += delta.text
            handlers.onContent?.(delta.text, content)
          } else if (delta.type === 'thinking_delta') {
            reasoning += delta.thinking
            handlers.onReasoning?.(delta.thinking, reasoning)
          } else if (delta.type === 'input_json_delta') {
            const current = blocks.get(event.index)
            if (current) current.args += delta.partial_json
          }
          break
        }

        case 'message_delta':
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason
          if (event.usage?.output_tokens !== undefined) {
            usage = { ...usage, completionTokens: event.usage.output_tokens }
          }
          break
      }
    }
  } catch (err: unknown) {
    throw toChatError(err, request.provider.label)
  }

  const toolCalls: ToolCall[] = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id || `call_${index}`,
      type: 'function' as const,
      // An opened block with no delta means an argument-less call, not a broken one.
      function: { name: call.name, arguments: call.args || '{}' },
    }))

  return { content, reasoning, toolCalls, stopReason: normaliseStopReason(stopReason), usage }
}
