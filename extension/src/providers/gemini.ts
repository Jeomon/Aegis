/**
 * The Gemini dialect, on Google's own SDK.
 *
 * A third wire format. Where Anthropic renames things, Gemini restructures them: turns are
 * `contents` with the assistant called `model`, every payload is a `part`, tool calls and
 * their results are parts rather than separate fields, and a tool result is matched to its
 * call by *function name* rather than by id — so the id our loop carries has to be resolved
 * back to a name during conversion.
 *
 * As with anthropic.ts, the conversion is contained here and the agent loop sees only
 * ChatResult.
 */

import { GoogleGenAI } from '@google/genai'
import type {
  Content,
  FunctionDeclaration,
  GenerateContentResponse,
  Part,
  Schema,
} from '@google/genai'

import type { ChatMessage, ChatRequest, ChatResult, StreamHandlers, ToolCall } from './chat'
import { ChatError, normaliseStopReason } from './chat'

// ---------------------------------------------------------------------------------------
// Request conversion
// ---------------------------------------------------------------------------------------

function imagePart(dataUrl: string): Part | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl)
  if (!match) return undefined
  return { inlineData: { mimeType: match[1], data: match[2] } }
}

function contentParts(content: ChatMessage['content']): Part[] {
  if (typeof content === 'string') return content ? [{ text: content }] : []

  const parts: Part[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) parts.push({ text: part.text })
    } else {
      const image = imagePart(part.image_url.url)
      if (image) parts.push(image)
    }
  }
  return parts
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
 * Convert our OpenAI-shaped history into Gemini `contents`.
 *
 * The system prompt is hoisted; the assistant becomes `model`; tool calls become
 * functionCall parts and results become functionResponse parts on a user turn. Because
 * Gemini keys a response to its call by name, the ids seen on assistant turns are indexed
 * first so each tool result can name the function it answers.
 */
export function toGeminiContents(messages: ChatMessage[]): {
  system: string
  contents: Content[]
} {
  const system: string[] = []
  const contents: Content[] = []

  const nameForCallId = new Map<string, string>()
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) nameForCallId.set(call.id, call.function.name)
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string' ? message.content : ''
      if (text) system.push(text)
      continue
    }

    let role: 'user' | 'model'
    let parts: Part[]

    if (message.role === 'tool') {
      role = 'user'
      const name = nameForCallId.get(message.tool_call_id ?? '') ?? 'unknown'
      parts = [
        {
          functionResponse: {
            name,
            // Gemini expects a structured response object, not a bare string.
            response: { result: typeof message.content === 'string' ? message.content : '' },
          },
        },
      ]
    } else {
      role = message.role === 'assistant' ? 'model' : 'user'
      parts = contentParts(message.content)
      for (const call of message.tool_calls ?? []) {
        parts.push({
          functionCall: { name: call.function.name, args: parseArguments(call.function.arguments) },
        })
      }
    }

    if (!parts.length) continue

    const previous = contents[contents.length - 1]
    if (previous?.role === role) previous.parts?.push(...parts)
    else contents.push({ role, parts })
  }

  return { system: system.join('\n\n'), contents }
}

/** Gemini groups declarations under a single tool entry, keyed `functionDeclarations`. */
export function toGeminiTools(tools: unknown[] | undefined): FunctionDeclaration[] | undefined {
  if (!tools?.length) return undefined

  return tools.map((tool) => {
    const fn = (tool as { function?: { name?: string; description?: string; parameters?: unknown } })
      .function
    return {
      name: fn?.name ?? '',
      description: fn?.description ?? '',
      parameters: fn?.parameters as Schema | undefined,
    }
  })
}

/**
 * Gemini prices reasoning as a token budget like Anthropic, but 0 is meaningful: it
 * disables thinking on the models that allow it. -1 would hand the decision back to the
 * model, which we never want when latency is being measured.
 */
export function thinkingBudget(level: string | undefined): number | undefined {
  switch (level) {
    case 'off':
      return 0
    case 'minimal':
      return 512
    case 'low':
      return 2048
    case 'medium':
      return 8192
    case 'high':
      return 16384
    case 'xhigh':
      return 24576
    case 'max':
      return 32768
    default:
      return undefined
  }
}

export function buildGeminiConfig(request: ChatRequest): Record<string, unknown> {
  const { system } = toGeminiContents(request.messages)
  const declarations = toGeminiTools(request.tools)
  const budget = thinkingBudget(request.thinking)

  return {
    ...(system ? { systemInstruction: system } : {}),
    ...(declarations ? { tools: [{ functionDeclarations: declarations }] } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
    ...(budget === undefined
      ? {}
      : {
          // includeThoughts surfaces the trace as parts flagged `thought`, which is the only
          // way to show reasoning in the panel rather than silently paying for it.
          thinkingConfig: { thinkingBudget: budget, includeThoughts: budget > 0 },
        }),
    ...(request.signal ? { abortSignal: request.signal } : {}),
  }
}

// ---------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------

function clientFor(request: ChatRequest): GoogleGenAI {
  if (!request.apiKey) {
    throw new ChatError(
      `${request.provider.label} needs a credential (${request.provider.credentialName}).`,
      0,
      '',
    )
  }
  return new GoogleGenAI({ apiKey: request.apiKey })
}

function toChatError(err: unknown, providerLabel: string): ChatError {
  if (err instanceof ChatError) return err

  const message = (err as Error).message ?? String(err)
  // The SDK reports HTTP failures as an Error whose message carries the status and payload.
  const status = /\b(\d{3})\b/.exec(message)
  return new ChatError(`${providerLabel}: ${message}`, status ? Number(status[1]) : 0, message)
}

// ---------------------------------------------------------------------------------------
// Response conversion
// ---------------------------------------------------------------------------------------

/**
 * Gemini reports STOP even when it has asked for a tool, so the presence of function calls
 * decides the stop reason before the reported one is consulted.
 */
function stopReasonFor(reported: string | undefined, sawToolCall: boolean): ChatResult['stopReason'] {
  if (sawToolCall) return 'tool_calls'
  return normaliseStopReason(reported?.toLowerCase())
}

interface Accumulated {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
}

/** Fold one response chunk into the running result, returning what was newly added. */
function foldChunk(
  chunk: GenerateContentResponse,
  acc: Accumulated,
): { text: string; thought: string; opened: string[] } {
  const candidate = chunk.candidates?.[0]
  const added = { text: '', thought: '', opened: [] as string[] }

  for (const part of candidate?.content?.parts ?? []) {
    if (part.functionCall) {
      const index = acc.toolCalls.length
      acc.toolCalls.push({
        // Gemini does not issue call ids, but the rest of the loop keys tool results by one,
        // so a stable synthetic id is minted per call.
        id: part.functionCall.id ?? `call_${index}`,
        type: 'function',
        function: {
          name: part.functionCall.name ?? '',
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      })
      added.opened.push(part.functionCall.name ?? '')
    } else if (typeof part.text === 'string') {
      // The reasoning trace arrives as ordinary text parts flagged `thought`.
      if (part.thought) {
        acc.reasoning += part.text
        added.thought += part.text
      } else {
        acc.content += part.text
        added.text += part.text
      }
    }
  }

  return added
}

function usageFrom(response: GenerateContentResponse): ChatResult['usage'] {
  return {
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
  }
}

export async function geminiChat(request: ChatRequest): Promise<ChatResult> {
  const ai = clientFor(request)
  const { contents } = toGeminiContents(request.messages)

  try {
    const response = await ai.models.generateContent({
      model: request.model,
      contents,
      config: buildGeminiConfig(request),
    })

    const acc: Accumulated = { content: '', reasoning: '', toolCalls: [] }
    foldChunk(response, acc)

    return {
      ...acc,
      stopReason: stopReasonFor(response.candidates?.[0]?.finishReason, acc.toolCalls.length > 0),
      usage: usageFrom(response),
    }
  } catch (err: unknown) {
    throw toChatError(err, request.provider.label)
  }
}

/**
 * Streaming. Unlike the other two dialects Gemini sends whole parts rather than fragments,
 * so a function call arrives complete and needs no reassembly — but text still accumulates
 * across chunks.
 */
export async function geminiChatStream(
  request: ChatRequest,
  handlers: StreamHandlers = {},
): Promise<ChatResult> {
  const ai = clientFor(request)
  const { contents } = toGeminiContents(request.messages)

  const acc: Accumulated = { content: '', reasoning: '', toolCalls: [] }
  let finishReason: string | undefined
  let usage: ChatResult['usage']
  let announced = 0

  try {
    const stream = await ai.models.generateContentStream({
      model: request.model,
      contents,
      config: buildGeminiConfig(request),
    })

    for await (const chunk of stream) {
      const added = foldChunk(chunk, acc)

      if (added.thought) handlers.onReasoning?.(added.thought, acc.reasoning)
      if (added.text) handlers.onContent?.(added.text, acc.content)
      for (const name of added.opened) handlers.onToolCallStart?.(name, announced++)

      const reported = chunk.candidates?.[0]?.finishReason
      if (reported) finishReason = reported
      if (chunk.usageMetadata) usage = usageFrom(chunk)
    }
  } catch (err: unknown) {
    throw toChatError(err, request.provider.label)
  }

  return {
    ...acc,
    stopReason: stopReasonFor(finishReason, acc.toolCalls.length > 0),
    usage,
  }
}
