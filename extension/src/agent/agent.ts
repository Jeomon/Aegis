/**
 * The agent loop: observe, call, execute, repeat.
 *
 * Structured after browser_use's turn cycle. The observation is rebuilt from the live page
 * on every step and appended as the *last* message, never persisted into history — so the
 * model always reasons about the current page rather than a stale snapshot, and element
 * ids in the transcript can never be mistaken for current ones.
 *
 * What the model is shown is controlled by the observation mode: the accessibility tree
 * (text only, no pixels), an annotated screenshot, or both. Whichever is chosen, the
 * observation and the image are equally ephemeral — neither is ever written into history,
 * so the model always reasons about the page as it is now.
 *
 * The screenshot modes send raw pixels. SIH26171 requires that visual context be redacted
 * before it leaves the device, and the cascade does not exist yet, so those modes are
 * currently non-compliant and marked as such in the settings UI.
 */

import { concealForSession, restoreForAction } from '../observe/redact/session-vault'
import { ChatError, chatStream, toolTurn, userTurn } from '../providers/chat'
import type { ChatMessage } from '../providers/chat'
import { annotateScreenshot } from '../observe/annotate'
import { captureScreenshot, executeToolCall, runAction, scanPage } from './browser'
import type { TabInfo } from './browser'
import { renderObservation } from '../observe/observation'
import { buildSystemPrompt } from './prompt'
import { resolveTarget } from '../shared/settings'
import { BROWSER_TOOL } from './tools'

/**
 * A runaway guard, not the termination mechanism — the stop reason decides when a turn is
 * over. This only catches a model that keeps calling tools forever without concluding,
 * which is a real failure mode worth surfacing rather than looping on.
 */
const RUNAWAY_LIMIT = 30

/**
 * Capacity failures arrive as an SSE frame after HTTP 200, so the SDK's retry logic never
 * sees a retryable status and surfaces them immediately. Observed consistently on the
 * first request against NVIDIA's shared tier, which is why it looked like "the first
 * attempt after a reload always fails".
 */
const CAPACITY = /resourceexhausted|request limit|at capacity|overload|too many requests/i
const RETRY_DELAYS_MS = [1500, 4000]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Expand any session handles inside a tool call's arguments.
 *
 * Only string fields are touched, and the kind travels with the value so the page can apply
 * the same rule it applies to its own handles — a secret only ever enters a field of its
 * own kind, whichever vault it came from.
 */
function restoreArguments(raw: string): unknown {
  const parsed = JSON.parse(raw) as Record<string, unknown>

  if (typeof parsed.text === 'string') {
    const restored = restoreForAction(parsed.text)
    if (restored.kinds.length) {
      parsed.text = restored.text
      parsed.expectKind = restored.kinds[0]
    }
  }
  return parsed
}

export interface AgentEvents {
  /** A new step of the loop begins — reset any live bubbles. */
  onStep: (step: number) => void
  /** Reasoning tokens, as they arrive. */
  onReasoning: (delta: string) => void
  /** Assistant prose tokens, as they arrive. */
  onDelta: (delta: string) => void
  /** The completed assistant message, once the stream closes. */
  onMessage: (text: string) => void
  /** A tool the model chose to call, with its fully reassembled arguments. */
  onToolCall: (name: string, args: string) => void
  /** What the tool returned, and whether it succeeded. */
  onToolResult: (text: string, ok: boolean) => void
  onError: (text: string) => void
}

/**
 * Run one user turn to completion. `history` is mutated so the caller keeps the
 * conversation across turns; observations are deliberately not written into it.
 */
export async function runAgentTurn(
  userText: string,
  history: ChatMessage[],
  events: AgentEvents,
  signal?: AbortSignal,
): Promise<void> {
  const target = await resolveTarget()
  if ('error' in target) {
    events.onError(target.error)
    return
  }

  // The user's own message is a source of PII like any other, and an unredacted one does
  // not merely leak: the egress guard fails closed, so the turn would die instead. The
  // value stays in the session vault and the model receives a handle it can direct.
  history.push({ role: 'user', content: concealForSession(userText) })

  for (let step = 0; ; step++) {
    if (signal?.aborted) return

    if (step >= RUNAWAY_LIMIT) {
      events.onError(
        `Stopped after ${RUNAWAY_LIMIT} actions without reaching an answer. The model kept ` +
          'acting instead of concluding — narrow the instruction, or say what "done" looks like.',
      )
      return
    }

    events.onStep(step)
    const wantsTree = target.observationMode !== 'screenshot'
    const wantsImage = target.observationMode !== 'tree'
    console.log('[Aegis] observationMode=', target.observationMode, 'wantsImage=', wantsImage)

    let observation: string
    let image: string | undefined

    try {
      const scan = await scanPage()
      const tabs = await runAction({ type: 'tab', op: 'list' })
      observation = renderObservation(scan, (tabs.data as TabInfo[]) ?? [], wantsTree)

      if (wantsImage) {
        // Redacted and labelled in one pass: sensitive regions painted out, then the same
        // ids the tree uses drawn on top, so the two views agree on what is what.
        const capture = await captureScreenshot()
        const annotated = await annotateScreenshot(capture, scan.elements, {
          devicePixelRatio: scan.viewport.devicePixelRatio,
          viewportWidth: scan.viewport.width,
          piiRegions: scan.piiRegions,
        })
        image = annotated.dataUrl

        // Stated in the observation rather than left implicit: a black rectangle is a
        // deliberate mask, not a rendering failure to be retried or worked around.
        if (annotated.masked > 0) {
          observation +=
            `\n\n${annotated.masked} region${annotated.masked === 1 ? '' : 's'} in the ` +
            'screenshot are painted out because they hold personal data. That is expected. ' +
            'Use the [redacted:kind#n] handles from the element states to work with those ' +
            'values.'
        }
      }
    } catch (err: unknown) {
      console.error('[Aegis] observation/annotate step failed:', err)
      // A browser-internal page has no observation; the model can still answer from history.
      observation = `Browser state unavailable: ${err instanceof Error ? err.message : String(err)}`
      image = undefined
    }

    // Built fresh every step and never pushed to history — the image is as ephemeral as
    // the text, so a stale screenshot can never be mistaken for the current page.
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt({ observationMode: target.observationMode }) },
      ...history,
      userTurn(observation, image),
    ]

    let result
    try {
      result = await withCapacityRetry(signal, () =>
        chatStream(
        {
          provider: target.provider,
          model: target.model.id,
          apiKey: target.apiKey,
          messages,
          tools: [BROWSER_TOOL],
          thinking: target.thinking,
          thinkingFormat: target.model.thinkingFormat,
          signal,
        },
        {
          onReasoning: (delta) => events.onReasoning(delta),
          onContent: (delta) => events.onDelta(delta),
        },
        ),
      )
    } catch (err: unknown) {
      if (signal?.aborted) return // the user moved on; not a failure worth reporting
      events.onError(describeFailure(err, target.provider.label, target.model.id))
      return
    }

    // The stop reason decides whether the turn is over, not a step counter. A model that
    // is still calling tools has not finished; one that stopped for any other reason has,
    // and the reason is worth reporting rather than flattening into silence.
    if (!result.toolCalls.length) {
      const text = result.content.trim()

      switch (result.stopReason) {
        case 'length':
          history.push({ role: 'assistant', content: text })
          events.onMessage(text)
          events.onError('The reply hit the model’s output limit and was cut short.')
          return

        case 'content_filter':
          events.onError('The model’s safety filter stopped this response.')
          return

        case 'abort':
          return // the user cancelled; nothing to report

        case 'error':
          events.onError('The model stopped for an unknown reason and produced no answer.')
          return

        default: {
          const answer = text || '(the model returned nothing)'
          history.push({ role: 'assistant', content: answer })
          events.onMessage(answer)
          return
        }
      }
    }

    // Keep the assistant's tool_calls turn: providers reject tool results without it.
    // Null rather than '' when the model said nothing — see ChatMessage.content.
    history.push({
      role: 'assistant',
      content: result.content?.trim() ? result.content : null,
      tool_calls: result.toolCalls,
    })

    for (const call of result.toolCalls) {
      events.onToolCall(call.function.name, call.function.arguments)

      let outcome: { ok: boolean; message: string }
      try {
        // Handles the panel minted are expanded here, one step before the action reaches
        // the page — the page's vault never saw these values and could not resolve them.
        outcome = await executeToolCall(restoreArguments(call.function.arguments))
      } catch {
        outcome = {
          ok: false,
          message: `Invalid tool call: arguments were not valid JSON — ${call.function.arguments}`,
        }
      }

      // Tool results are permanent in history, so an identifier echoed by one — a tab
      // title, a URL, whatever evaluate returned — would sit in the transcript for every
      // later turn. Redacting the observation but not the results would be theatre.
      const redacted = concealForSession(outcome.message)
      events.onToolResult(redacted, outcome.ok)
      history.push(toolTurn(call.id, redacted))
    }
  }

}

/**
 * Retry a request the provider refused for capacity reasons. Only capacity: a bad model id
 * or a rejected credential will fail identically on every attempt, so retrying those just
 * wastes the user's time.
 */
async function withCapacityRetry<T>(
  signal: AbortSignal | undefined,
  attempt: () => Promise<T>,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (err: unknown) {
      // Both, not just the body: a capacity refusal that arrives as an SSE frame after
      // HTTP 200 is not an APIError, so it reaches ChatError with an empty body and the
      // text only in the message. Testing the body alone meant this retry never fired for
      // the one error it exists for.
      const retryable =
        err instanceof ChatError && CAPACITY.test(`${err.body} ${err.message}`)
      if (!retryable || i >= RETRY_DELAYS_MS.length || signal?.aborted) throw err
      await sleep(RETRY_DELAYS_MS[i])
    }
  }
}

/** Turn a provider failure into something that says what to change. */
function describeFailure(err: unknown, providerLabel: string, modelId: string): string {
  if (!(err instanceof ChatError)) {
    return err instanceof Error ? err.message : String(err)
  }

  const detail = err.body ? `\n${err.body}` : ''
  // Capacity exhaustion arrives with assorted status codes and only the text distinguishes
  // it from a real fault. It is the provider being busy, not anything the user did wrong.
  if (/resourceexhausted|request limit|at capacity|overload|too many requests|try again/i.test(err.body)) {
    return (
      `${providerLabel} is out of capacity right now, not broken. This is the shared free ` +
      `tier filling up — your key is fine.\n\nRetry in a moment, or switch provider in ` +
      `settings (a local Ollama never queues).${detail}`
    )
  }

  switch (err.status) {
    case 401:
    case 403:
      return `${providerLabel} rejected the credential (${err.status}). Check the key in settings.${detail}`
    case 404:
      return `${providerLabel} does not recognise the model ${JSON.stringify(modelId)} (404). Pick another in settings.${detail}`
    case 429:
      return `${providerLabel} rate-limited the request (429). Wait, or switch provider.${detail}`
    case 500:
    case 502:
    case 503:
      return `${providerLabel} had a server-side failure (${err.status}). Retry, or switch provider in settings.${detail}`
    default:
      return `${providerLabel} failed: ${err.message}${detail}`
  }
}
