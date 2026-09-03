/**
 * The side panel. Runs in an extension document, so it has direct access to chrome.* —
 * no messaging through the service worker is needed to read, scan or drive the active tab.
 */

import type { BrowserAction } from './shared/actions'
import { runAgentTurn } from './agent/agent'
import { captureScreenshot, executeToolCall, runAction, scanPage } from './agent/browser'
import type { ChatMessage } from './providers/chat'
import type { TabInfo } from './agent/browser'
import { COMMAND_HELP, invalidatesScan, parseCommand, startsNavigation } from './ui/command'
import { describeAction } from './ui/describe'
import { setMarkdown } from './ui/markdown'
import { renderObservation } from './observe/observation'
import {
  clearCredential,
  getCredential,
  getSettings,
  maskCredential,
  setCredential,
  setSettings,
} from './shared/settings'
import { PROVIDERS, checkUsable, getProvider, modelsFor } from './providers/registry'
import { mountSettings } from './ui/settings-panel'
import type { Message, PageContext, ScanResult } from './shared/types'
import { installEgressGuard } from './observe/redact/egress'
import { mountNetworkPanel } from './ui/network-panel'
import { annotateScreenshot } from './observe/annotate'
import { stripControlTokens } from './shared/control-tokens'

// Installed before anything can issue a request: the SDKs call fetch, so wrapping it is
// the one place every provider path must pass through.
installEgressGuard()
mountNetworkPanel()

const messagesEl = document.querySelector<HTMLDivElement>('#messages')!
const formEl = document.querySelector<HTMLFormElement>('#composer')!
const inputEl = document.querySelector<HTMLTextAreaElement>('#input')!
const sendEl = document.querySelector<HTMLButtonElement>('#send')!
const scanEl = document.querySelector<HTMLButtonElement>('#scan')!
const contextEl = document.querySelector<HTMLDivElement>('#context')!

const history: Message[] = []
let page: PageContext | null = null
let lastScan: ScanResult | null = null

/* ---------------------------------------------------------------- page context */

async function refreshContext(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })

  if (!tab?.url) {
    page = null
    contextEl.textContent = 'No page'
    contextEl.title = ''
    return
  }

  let host = ''
  try {
    host = new URL(tab.url).host
  } catch {
    host = tab.url
  }

  page = { title: tab.title ?? '', url: tab.url, host }
  contextEl.textContent = page.title || host || 'Untitled'
  contextEl.title = page.url
}

chrome.tabs.onActivated.addListener(() => void refreshContext())
chrome.tabs.onUpdated.addListener((_id, changed, tab) => {
  if (tab.active && (changed.title || changed.url || changed.status === 'complete')) {
    lastScan = null // the page moved on; the ids are stale
    void refreshContext()
  }
})

/* ---------------------------------------------------------------- rendering */

/**
 * Append-only. Rebuilding the whole list on every streamed token would be quadratic and
 * would also discard the element a live bubble is writing into.
 */
function paint(bubble: HTMLElement, message: Message): void {
  // User text and monospace blocks stay literal; assistant prose is markdown.
  if (message.mono || message.role === 'user') bubble.textContent = message.text
  else setMarkdown(bubble, message.text)

  // Whitespace is not empty to CSS — a bubble holding only a space still has a text node,
  // so :empty never matches it. Decide here, where the content is actually knowable.
  const row = bubble.closest('.msg')
  if (row instanceof HTMLElement) row.hidden = !message.text.trim()
}

/** The centred placeholder is removed by the first thing that arrives, whatever it is. */
function clearEmptyState(): void {
  document.querySelector('#empty')?.remove()
}

function appendMessage(message: Message): HTMLElement {
  clearEmptyState()
  if (message.tool) return appendToolCard(message)

  const row = document.createElement('div')
  row.className = `msg ${message.role}`

  const bubble = document.createElement('div')
  bubble.className = `bubble${message.mono ? ' mono' : ''}${message.dim ? ' dim' : ''}`
  paint(bubble, message)

  if (message.receipt) bubble.append(receipt(message.receipt))

  if (message.image) {
    const img = document.createElement('img')
    img.className = 'capture'
    img.src = message.image
    img.alt = 'The page as the model receives it, with personal data painted out'
    bubble.append(img)
  }

  row.append(bubble)
  messagesEl.append(row)
  messagesEl.scrollTop = messagesEl.scrollHeight
  return bubble
}

/**
 * What a scan withheld, stated as a result rather than logged as a line.
 *
 * The count leads because it is the claim; the bar beside it is the same black the capture
 * is painted with, so the interface is made of the artifact's own material rather than
 * describing it. With nothing to withhold there is no bar — an empty one would imply a
 * protection that did not happen.
 */
function receipt(data: { summary: string; masked: number }): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'receipt'

  const line = document.createElement('div')
  line.className = 'receipt-line'

  if (data.masked > 0) {
    const count = document.createElement('span')
    count.className = 'receipt-count'
    count.textContent = String(data.masked)

    const label = document.createElement('span')
    label.textContent = data.masked === 1 ? 'region withheld' : 'regions withheld'

    const bar = document.createElement('span')
    bar.className = 'receipt-bar'
    line.append(count, label, bar)
  } else {
    const label = document.createElement('span')
    label.textContent = 'nothing to withhold on this page'
    line.append(label)
  }

  const note = document.createElement('div')
  note.className = 'receipt-note'
  note.textContent = data.summary

  wrap.append(line, note)
  return wrap
}

/**
 * An action the agent took, rendered as an activity card. The humanised verb leads; the
 * raw arguments stay reachable but folded away.
 */
function appendToolCard(message: Message): HTMLElement {
  const tool = message.tool!

  const card = document.createElement('div')
  card.className = 'tool'

  const head = document.createElement('div')
  head.className = 'tool-head'

  const verb = document.createElement('span')
  verb.className = 'tool-verb'
  verb.textContent = tool.verb

  const detail = document.createElement('span')
  detail.className = 'tool-detail'
  detail.textContent = tool.detail

  const status = document.createElement('span')
  status.className = 'tool-status'

  head.append(verb, detail, status)
  card.append(head)

  const result = document.createElement('div')
  result.className = 'tool-result'
  card.append(result)

  if (tool.raw) {
    const raw = document.createElement('details')
    raw.className = 'tool-raw'
    const summary = document.createElement('summary')
    summary.textContent = 'arguments'
    const pre = document.createElement('pre')
    pre.textContent = tool.raw
    raw.append(summary, pre)
    card.append(raw)
  }

  clearEmptyState()
  messagesEl.append(card)
  messagesEl.scrollTop = messagesEl.scrollHeight
  paintToolCard(card, message)
  return card
}

/** Reflect the current state of a tool card — running, succeeded, or failed. */
function paintToolCard(card: HTMLElement, message: Message): void {
  const tool = message.tool!
  const status = card.querySelector<HTMLSpanElement>('.tool-status')!
  const result = card.querySelector<HTMLDivElement>('.tool-result')!

  if (tool.result === undefined) {
    card.classList.add('running')
    status.textContent = '···'
    result.textContent = ''
    return
  }

  card.classList.remove('running')
  card.classList.toggle('failed', tool.ok === false)
  status.textContent = tool.ok === false ? '✕' : '✓'
  result.textContent = tool.result
}

/**
 * The agent is working. Not a message — it says nothing and is removed the moment there is
 * something real to show, so it never lingers in the transcript.
 */
function showWorking(): HTMLElement {
  clearEmptyState()
  const row = document.createElement('div')
  row.className = 'msg assistant'
  const dots = document.createElement('div')
  dots.className = 'working'
  dots.setAttribute('aria-label', 'Working')
  for (let i = 0; i < 3; i++) dots.append(document.createElement('span'))
  row.append(dots)
  messagesEl.append(row)
  messagesEl.scrollTop = messagesEl.scrollHeight
  return row
}

function say(role: Message['role'], text: string, mono = false, dim = false): void {
  if (!text.trim()) return // an empty bubble is noise, never information
  const message: Message = { role, text, mono, dim }
  history.push(message)
  appendMessage(message)
}

export interface LiveBubble {
  append: (delta: string) => void
  finish: () => void
}

/**
 * A bubble that grows as tokens arrive. Repaints are coalesced into an animation frame so
 * a fast stream cannot re-parse the markdown once per character.
 */
function beginLive(options: { dim?: boolean; mono?: boolean } = {}): LiveBubble {
  // Created lazily. A model often emits a stray space or newline before calling a tool,
  // and an eagerly-created bubble would render that as an empty box sitting in the
  // transcript. Nothing appears until there is something worth showing.
  let message: Message | null = null
  let bubble: HTMLElement | null = null
  let text = ''
  let scheduled = false

  const ensure = (): void => {
    if (message) return
    message = { role: 'assistant', text, mono: options.mono, dim: options.dim }
    history.push(message)
    bubble = appendMessage(message)
  }

  const flush = (): void => {
    scheduled = false
    if (!message || !bubble) return
    // Stripped from the accumulated buffer rather than each delta: a control token split
    // across two chunks is only recognisable once both have arrived.
    message.text = stripControlTokens(text)
    paint(bubble, message)
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  return {
    append(delta) {
      text += delta
      if (!text.trim()) return // still only whitespace — nothing to show yet
      ensure()
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(flush)
    },

    finish() {
      // Never leave behind a bubble that renders to nothing.
      if (message && !text.trim()) {
        const index = history.indexOf(message)
        if (index !== -1) history.splice(index, 1)
        bubble?.closest('.msg')?.remove()
        message = null
        bubble = null
        return
      }
      flush()
    },
  }
}

export interface ToolCard {
  complete: (result: string, ok: boolean) => void
}

/** Show an action as running, and return a handle to fill in its outcome. */
function beginToolCard(rawArguments: string): ToolCard {
  const { verb, detail } = describeAction(rawArguments)

  const message: Message = {
    role: 'assistant',
    text: '',
    tool: { verb, detail, raw: prettyJson(rawArguments) },
  }
  history.push(message)
  const card = appendToolCard(message)

  return {
    complete(result, ok) {
      message.tool!.result = result
      message.tool!.ok = ok
      paintToolCard(card, message)
      messagesEl.scrollTop = messagesEl.scrollHeight
    },
  }
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/* ---------------------------------------------------------------- scanning */

async function runScan(quiet = false): Promise<void> {
  scanEl.disabled = true
  try {
    const scan = await scanPage()
    lastScan = scan

    // The element tree is the model's input, not conversation. Rendering it after every
    // action buried the actual exchange under hundreds of lines of page structure, so it
    // never appears in the chat — `obs` still prints it on demand for debugging.
    if (!quiet) {
      const { counts } = scan
      await showCapture(scan, `${counts.final} interactive elements · ${scan.scanMs} ms`)
    }
  } catch (err: unknown) {
    say('assistant', err instanceof Error ? err.message : String(err))
  } finally {
    scanEl.disabled = false
  }
}

/**
 * Show the page exactly as the model would receive it.
 *
 * Scanning is the one moment a user can check the claim rather than take it, so this runs
 * the same capture and the same masking the agent loop runs — not a preview of it. If the
 * two ever diverge, the panel is reassuring about something that is not happening.
 *
 * The image is not added to history: it is a screenshot of a moment, and a stale one would
 * mislead exactly where accuracy matters.
 */
async function showCapture(scan: ScanResult, summary: string): Promise<void> {
  let annotated
  try {
    annotated = await annotateScreenshot(await captureScreenshot(), scan.elements, {
      devicePixelRatio: scan.viewport.devicePixelRatio,
      viewportWidth: scan.viewport.width,
      piiRegions: scan.piiRegions,
    })
  } catch {
    // A page the browser refuses to capture — chrome:// and the store — still has a tree.
    say('assistant', `${summary} · no capture available on this page`)
    return
  }

  appendMessage({
    role: 'assistant',
    text: '',
    image: annotated.dataUrl,
    receipt: { summary, masked: annotated.masked },
  })
}

/* ---------------------------------------------------------------- actions */

async function dispatch(action: BrowserAction): Promise<void> {
  const result = await runAction(action)
  say('assistant', result.message)

  if (!result.ok) return

  // Mirrors browser_use's per-turn observation refresh: after anything that could have
  // changed the page, the old ids are not trustworthy, so take a fresh look.
  if (invalidatesScan(action)) {
    if (startsNavigation(action)) {
      await new Promise((resolve) => setTimeout(resolve, 600)) // let the load start
    }
    await runScan(true)
    await refreshContext()
  }
}

/* ---------------------------------------------------------------- model-facing path */

/** Show the exact message a model would be handed this turn. */
async function showObservation(): Promise<void> {
  try {
    const scan = await scanPage()
    lastScan = scan
    const tabs = await runAction({ type: 'tab', op: 'list' })
    say('assistant', renderObservation(scan, (tabs.data as TabInfo[]) ?? []), true)
  } catch (err: unknown) {
    say('assistant', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Run a raw tool-call payload through the same path a model would take: validate, execute,
 * return the tool result text.
 */
async function runToolCall(json: string): Promise<void> {
  if (!json) {
    say('assistant', 'Usage: tool {"action":"click","elementId":3}')
    return
  }

  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    say('assistant', `Not valid JSON: ${json}`)
    return
  }

  const card = beginToolCard(JSON.stringify(payload))
  const outcome = await executeToolCall(payload)
  card.complete(outcome.message, outcome.ok)
  await runScan(true)
}

/* ---------------------------------------------------------------- provider settings */

/** Current provider, model and whether a credential is present — never the credential. */
async function showConfig(): Promise<void> {
  const settings = await getSettings()
  const provider = getProvider(settings.providerId)
  const lines = [
    `provider: ${provider?.label ?? settings.providerId} (${settings.providerId})`,
    `model:    ${settings.modelId}`,
    `endpoint: ${provider?.baseUrl ?? '—'}`,
  ]

  if (provider?.requiresCredential) {
    const credential = await getCredential(provider.id)
    lines.push(`key:      ${credential ? maskCredential(credential) : 'not set'}`)
  } else {
    lines.push('key:      not required (local runtime)')
  }

  lines.push('', `providers: ${PROVIDERS.map((p) => p.id).join(', ')}`)
  say('assistant', lines.join('\n'), true)
}

/** `use <provider> [model]` */
async function useProvider(rest: string): Promise<void> {
  const [providerId, ...modelParts] = rest.split(/\s+/)
  const provider = getProvider(providerId)
  if (!provider) {
    say('assistant', `Unknown provider. Known: ${PROVIDERS.map((p) => p.id).join(', ')}.`)
    return
  }

  const modelId = modelParts.join(' ') || modelsFor(provider.id)[0]?.id
  if (!modelId) {
    say('assistant', `No default model for ${provider.label} — give one: use ${provider.id} <model>`)
    return
  }

  const known = modelsFor(provider.id).find((m) => m.id === modelId)
  if (known) {
    const compliance = checkUsable(known)
    if (!compliance.ok) {
      say('assistant', `Refused: ${compliance.reason}`)
      return
    }
  }

  await setSettings({ providerId: provider.id, modelId })
  say('assistant', `Using ${provider.label} · ${modelId}.`)
  await showConfig()
}

/** `key <provider> <value>` or `key clear <provider>`. The value is never echoed. */
async function setKey(rest: string): Promise<void> {
  const [first, ...restParts] = rest.split(/\s+/)

  if (first === 'clear') {
    const providerId = restParts[0]
    if (!getProvider(providerId)) {
      say('assistant', `Unknown provider. Known: ${PROVIDERS.map((p) => p.id).join(', ')}.`)
      return
    }
    await clearCredential(providerId)
    say('assistant', `Cleared the ${providerId} credential.`)
    return
  }

  const provider = getProvider(first)
  const value = restParts.join('')
  if (!provider || !value) {
    say('assistant', 'Usage: key <provider> <value>   ·   key clear <provider>')
    return
  }

  await setCredential(provider.id, value)
  say(
    'assistant',
    `Stored a credential for ${provider.label} (${maskCredential(value)}).\n` +
      'It lives in chrome.storage.local for this browser profile only — not in the build, ' +
      'and not in the repository.',
  )
}
/* ---------------------------------------------------------------- chat fallback */

function respond(input: string): string {
  const text = input.toLowerCase().trim()

  if (/^(hi|hello|hey|yo)\b/.test(text)) {
    return 'Hello. Type "help" for the commands I can run without a model.'
  }

  if (text === 'help' || text.includes('what can you do')) {
    return `Commands:\n${COMMAND_HELP}\n\nAnything else needs a model connected.`
  }

  if (!page) return 'I cannot see an active tab at the moment.'

  if (text.includes('url') || text.includes('address')) return page.url
  if (text.includes('site') || text.includes('domain') || text.includes('host')) return page.host

  const roleMatch = /how many (\w+)/.exec(text)
  if (roleMatch) {
    if (!lastScan) return 'Nothing scanned yet — run "scan" first.'
    const wanted = roleMatch[1].replace(/s$/, '')
    const n = lastScan.elements.filter((el) => el.role === wanted).length
    return `${n} element${n === 1 ? '' : 's'} with role "${wanted}" in the last scan.`
  }

  if (text.includes('page') || text.includes('tab') || text.includes('title')) {
    return `${page.title || 'Untitled'}\n${page.url}`
  }

  return 'No model is connected yet, so I cannot answer that. Type "help" for what I can do without one.'
}

/* ---------------------------------------------------------------- composer */

function submit(): void {
  const text = inputEl.value.trim()
  if (!text) return

  // Handled before the echo: a credential must never reach the transcript.
  if (/^key\s+/i.test(text)) {
    inputEl.value = ''
    resize()
    sendEl.disabled = true
    say('user', 'key ••••••••')
    void setKey(text.slice(3).trim())
    return
  }

  say('user', text)
  inputEl.value = ''
  resize()
  sendEl.disabled = true

  const verb = text.toLowerCase()

  if (verb === 'scan') {
    void runScan()
    return
  }

  // Screenshot is not an action — it belongs to the observation path.
  if (verb === 'shot' || verb === 'screenshot') {
    void captureScreenshot()
      .then((dataUrl) => say('assistant', `Captured ${Math.round(dataUrl.length / 1024)} KB.`))
      .catch((err: unknown) => say('assistant', err instanceof Error ? err.message : String(err)))
    return
  }

  // The exact message a model would be handed this turn.
  if (verb === 'obs' || verb === 'observation') {
    void showObservation()
    return
  }

  if (verb === 'config') {
    void showConfig()
    return
  }

  if (verb.startsWith('use ')) {
    void useProvider(text.slice(4).trim())
    return
  }
  // Drive the model-facing path by hand: tool {"action":"click","elementId":3}
  if (verb.startsWith('tool ') || verb === 'tool') {
    void runToolCall(text.slice(4).trim())
    return
  }

  const action = parseCommand(text)
  if (action) {
    void dispatch(action)
    return
  }

  // 'help' stays local so it works with no provider configured; everything else is the
  // model's job now.
  if (verb === 'help' || verb.includes('what can you do')) {
    say('assistant', respond(text))
    return
  }

  void runModelTurn(text)
}

/* ---------------------------------------------------------------- the model */

const conversation: ChatMessage[] = []
let busy = false

/**
 * Cancels the in-flight request. Abandoning a stream without aborting it leaves the
 * provider holding the connection open — NVIDIA counts that against its 16-worker pool,
 * which is why the first request after a panel reload used to fail with ResourceExhausted.
 */
let inFlight: AbortController | null = null

addEventListener('pagehide', () => inFlight?.abort())
addEventListener('beforeunload', () => inFlight?.abort())

async function runModelTurn(text: string): Promise<void> {
  if (busy) {
    say('assistant', 'Still working on the previous turn.')
    return
  }

  busy = true
  sendEl.classList.add('busy')
  sendEl.disabled = false // still clickable — it is the stop control now
  sendEl.title = 'Stop'
  inputEl.disabled = true

  // One live bubble per channel, reset at each step of the loop.
  let reasoning: LiveBubble | null = null
  let prose: LiveBubble | null = null
  let pendingTool: ToolCard | null = null

  const closeLive = (): void => {
    reasoning?.finish()
    prose?.finish()
    reasoning = null
    prose = null
  }

  inFlight?.abort()
  const controller = new AbortController()
  inFlight = controller

  // Shown until the first thing the agent produces — a token, a tool call, or an error.
  // The gap before a model's first token is seconds long, and an unchanged panel in that
  // time is indistinguishable from a turn that never started.
  let working: HTMLElement | null = showWorking()
  const stopWorking = (): void => {
    working?.remove()
    working = null
  }

  try {
    await runAgentTurn(
      text,
      conversation,
      {
      onStep: closeLive,

      onReasoning: (delta) => {
        stopWorking()
        reasoning ??= beginLive({ dim: true })
        reasoning.append(delta)
      },

      onDelta: (delta) => {
        stopWorking()
        // Prose starting means the thinking for this step is done.
        reasoning?.finish()
        prose ??= beginLive()
        prose.append(delta)
      },

      onMessage: (message) => {
        stopWorking()
        if (prose) prose.finish()
        else say('assistant', message)
        closeLive()
      },

      onToolCall: (_name, args) => {
        stopWorking()
        closeLive()
        pendingTool = beginToolCard(args)
      },

      onToolResult: (result, ok) => {
        pendingTool?.complete(result, ok)
        pendingTool = null
      },

      onError: (message) => {
        stopWorking()
        closeLive()
        say('assistant', message)
      },
      },
      controller.signal,
    )
  } finally {
    stopWorking()
    if (inFlight === controller) inFlight = null
    closeLive()
    busy = false
    sendEl.classList.remove('busy')
    sendEl.disabled = inputEl.value.trim() === ''
    sendEl.title = 'Send'
    inputEl.disabled = false
    inputEl.focus()
  }
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault()
  // While a turn is running the same button is a stop, so submitting cancels it.
  if (busy) {
    inFlight?.abort()
    return
  }
  submit()
})

scanEl.addEventListener('click', () => void runScan())

inputEl.addEventListener('keydown', (event) => {
  // Enter sends, Shift+Enter makes a newline.
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
})

inputEl.addEventListener('input', () => {
  sendEl.disabled = inputEl.value.trim() === ''
  resize()
})

function resize(): void {
  inputEl.style.height = 'auto'
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`
}

/* ---------------------------------------------------------------- start */

// Closing settings should land you back in the conversation, not on a dead cursor.
mountSettings(() => inputEl.focus())

void refreshContext().then(() => inputEl.focus())
