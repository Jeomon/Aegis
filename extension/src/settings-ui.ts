/**
 * The settings view.
 *
 * One credential per provider, and a model picker restricted to providers that can
 * actually be used — a key is present, or the runtime is local and needs none. Choosing a
 * model you cannot reach is a failure you find out about mid-demo, so it is prevented here.
 */

import type { ObservationMode } from './lib/settings'
import {
  clearCredential,
  getCredential,
  getSettings,
  maskCredential,
  setCredential,
  setSettings,
} from './lib/settings'
import {
  MODELS,
  PROVIDERS,
  canDisableThinking,
  checkUsable,
  describeModalities,
  getProvider,
  hasVision,
  modelsFor,
  thinkingLevelsFor,
} from './providers'
import type { ProviderConfig } from './providers'

const toggleEl = document.querySelector<HTMLButtonElement>('#settingsToggle')!
const panelEl = document.querySelector<HTMLElement>('#settings')!
const providerSelect = document.querySelector<HTMLSelectElement>('#providerSelect')!
const modelSelect = document.querySelector<HTMLSelectElement>('#modelSelect')!
const providerList = document.querySelector<HTMLDivElement>('#providerList')!
const statusEl = document.querySelector<HTMLDivElement>('#activeStatus')!
const filterEl = document.querySelector<HTMLInputElement>('#modelFilter')!
const countEl = document.querySelector<HTMLDivElement>('#modelCount')!
const thinkingEl = document.querySelector<HTMLSelectElement>('#thinkingLevel')!
const modeEl = document.querySelector<HTMLSelectElement>('#observationMode')!
const warningEl = document.querySelector<HTMLDivElement>('#pixelWarning')!
const tabEls = [...document.querySelectorAll<HTMLButtonElement>('.tab')]
const panelEls = [...document.querySelectorAll<HTMLElement>('.tabpanel')]

/** Which providers are actually reachable right now. */
async function availability(): Promise<Map<string, string | undefined>> {
  const entries = await Promise.all(
    PROVIDERS.map(async (p) => [p.id, await getCredential(p.id)] as const),
  )
  return new Map(entries)
}

function usable(provider: ProviderConfig, credential: string | undefined): boolean {
  return !provider.requiresCredential || credential !== undefined
}

/** Show one tab's panel and mark its button selected. */
function selectTab(name: string): void {
  for (const tab of tabEls) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === name))
  }
  for (const panel of panelEls) {
    panel.hidden = panel.dataset.panel !== name
  }
  panelEls.find((p) => !p.hidden)?.scrollIntoView({ block: 'start' })
}

export function mountSettings(onClose?: () => void): void {
  for (const tab of tabEls) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab ?? 'model'))
  }

  toggleEl.addEventListener('click', () => {
    const opening = !panelEl.classList.contains('open')
    panelEl.classList.toggle('open', opening)
    document.body.classList.toggle('settings', opening)
    toggleEl.textContent = opening ? '✕' : '⚙'
    toggleEl.title = opening ? 'Close settings' : 'Settings'
    if (opening) {
      selectTab('model')
      void refresh()
    } else {
      onClose?.()
    }
  })

  providerSelect.addEventListener('change', async () => {
    const providerId = providerSelect.value
    const first = modelsFor(providerId)[0]?.id ?? ''
    await setSettings({ providerId, modelId: first })
    await refresh()
  })

  // Re-filtering is local, so no need to re-read storage.
  filterEl.addEventListener('input', () => void refresh())

  modeEl.addEventListener('change', async () => {
    await setSettings({ observationMode: modeEl.value as ObservationMode })
    await refresh()
  })

  thinkingEl.addEventListener('change', async () => {
    await setSettings({ thinkingLevel: thinkingEl.value })
    await refresh()
  })

  modelSelect.addEventListener('change', async () => {
    await setSettings({ modelId: modelSelect.value })
    await refresh()
  })
}

async function refresh(): Promise<void> {
  const settings = await getSettings()
  const keys = await availability()

  renderThinking(settings.providerId, settings.modelId, settings.thinkingLevel)
  renderMode(settings.providerId, settings.modelId, settings.observationMode)
  renderProviders(settings.providerId, keys)
  renderModels(settings.providerId, settings.modelId)
  renderCredentials(keys)
  renderStatus(settings.providerId, settings.modelId, keys)
}

function renderProviders(selected: string, keys: Map<string, string | undefined>): void {
  providerSelect.replaceChildren(
    ...PROVIDERS.map((provider) => {
      const option = document.createElement('option')
      const ready = usable(provider, keys.get(provider.id))
      option.value = provider.id
      option.textContent = ready ? provider.label : `${provider.label} — no key`
      option.disabled = !ready
      option.selected = provider.id === selected
      return option
    }),
  )
}

function renderModels(providerId: string, selected: string): void {
  const all = modelsFor(providerId)
  const needle = filterEl.value.trim().toLowerCase()

  // A model the agent cannot drive is never offered.
  const matches = all.filter((model) => {
    if (!checkUsable(model).ok) return false
    if (!needle) return true
    return `${model.id} ${model.label}`.toLowerCase().includes(needle)
  })

  // Keep a hand-typed id selectable so it is not silently replaced on reopening.
  const extra = selected && !all.some((m) => m.id === selected) ? [selected] : []

  if (!matches.length && !extra.length) {
    const option = document.createElement('option')
    option.textContent = needle ? `nothing matches “${needle}”` : 'no models for this provider'
    option.disabled = true
    modelSelect.replaceChildren(option)
    modelSelect.disabled = true
    countEl.textContent = `0 of ${all.length}`
    return
  }

  modelSelect.disabled = false
  modelSelect.replaceChildren(
    ...matches.map((model) => {
      const option = document.createElement('option')
      option.value = model.id
      const usableCheck = checkUsable(model)

      const notes: string[] = [describeModalities(model)]
      if (canDisableThinking(model)) notes.push('thinking off')
      if (model.verified) notes.push('verified')

      option.textContent = notes.length ? `${model.label} — ${notes.join(', ')}` : model.label
      option.disabled = !usableCheck.ok
      option.selected = model.id === selected
      return option
    }),
    ...extra.map((id) => {
      const option = document.createElement('option')
      option.value = id
      option.textContent = `${id} (custom)`
      option.selected = true
      return option
    }),
  )

  const usable = all.filter((m) => checkUsable(m).ok).length
  countEl.textContent = needle
    ? `${matches.length} of ${usable} match “${needle}”`
    : `${usable} models available`
}

/**
 * The reasoning control, populated from the chosen model's own supported set. A model with
 * no such control gets a disabled select saying so, rather than an option that would be
 * silently ignored on the wire.
 */
function renderThinking(providerId: string, modelId: string, selected: string): void {
  const model = MODELS.find((m) => m.provider === providerId && m.id === modelId)
  const levels = thinkingLevelsFor(model)

  if (!levels.length) {
    const option = document.createElement('option')
    option.textContent = model ? 'not adjustable on this model' : 'select a model first'
    option.disabled = true
    thinkingEl.replaceChildren(option)
    thinkingEl.disabled = true
    return
  }

  thinkingEl.disabled = false
  thinkingEl.replaceChildren(
    ...levels.map((level) => {
      const option = document.createElement('option')
      option.value = level
      option.textContent = level === 'off' ? 'off — fastest' : level
      option.selected = level === selected
      return option
    }),
  )

  // A level carried over from another model may not exist here. Show the cheapest instead,
  // but keep the stored choice — switching back to a model that supports it should restore
  // it rather than having quietly forgotten. resolveTarget() sends nothing unsupported.
  if (!levels.includes(selected)) {
    thinkingEl.value = levels.includes('off') ? 'off' : levels[0]
  }
}

/**
 * What each mode needs. DOM state is the floor — it is text and always available. Anything
 * that sends pixels requires the model to accept image input, so those options are offered
 * only when it does.
 */
const MODES: { value: ObservationMode; label: string; needsVision: boolean }[] = [
  { value: 'tree', label: 'DOM state — accessibility tree', needsVision: false },
  { value: 'screenshot', label: 'Screenshot — annotated', needsVision: true },
  { value: 'both', label: 'DOM state + screenshot', needsVision: true },
]

/**
 * The observation mode, plus an honest warning. A screenshot is exactly the visual context
 * SIH26171 requires to be sanitised before it leaves the device, and no redaction exists
 * yet — so the pixel modes are usable but not compliant, and say so.
 */
function renderMode(providerId: string, modelId: string, mode: ObservationMode): void {
  const model = MODELS.find((m) => m.provider === providerId && m.id === modelId)
  const vision = hasVision(model)

  // A mode the model cannot serve is shown but unselectable, so the reason is visible
  // rather than the option simply missing.
  modeEl.replaceChildren(
    ...MODES.map((entry) => {
      const option = document.createElement('option')
      option.value = entry.value
      const blocked = entry.needsVision && !vision
      option.textContent = blocked ? `${entry.label} — needs image input` : entry.label
      option.disabled = blocked
      return option
    }),
  )

  // Show what will actually happen, but do not overwrite the stored preference: a text-only
  // model would otherwise erase a screenshot setting, and switching back would silently
  // leave you on DOM state. resolveTarget() downgrades at request time, so nothing leaks.
  const effective: ObservationMode = vision ? mode : 'tree'
  modeEl.value = effective

  if (!vision) {
    warningEl.hidden = false
    warningEl.textContent = model
      ? `${model.label} takes ${model.input.join(', ')} only, so DOM state is the one ` +
        'option — a screenshot would be discarded.'
      : 'Pick a model to choose what it is shown.'
    return
  }

  if (effective === 'tree') {
    warningEl.hidden = true
    return
  }

  warningEl.hidden = false
  warningEl.textContent =
    'Screenshots are sent unredacted. SIH26171 requires visual context to be sanitised on ' +
    'the device first, and that cascade is not built yet — so this mode is for testing, ' +
    'not for the demo.'
}

function renderCredentials(keys: Map<string, string | undefined>): void {
  providerList.replaceChildren(
    ...PROVIDERS.map((provider) => card(provider, keys.get(provider.id))),
  )
}

function card(provider: ProviderConfig, credential: string | undefined): HTMLElement {
  const root = document.createElement('div')
  root.className = 'provider'

  const head = document.createElement('div')
  head.className = 'head'

  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = provider.label

  const badge = document.createElement('span')
  if (!provider.requiresCredential) {
    badge.className = 'badge'
    badge.textContent = 'no key needed'
  } else if (credential) {
    badge.className = 'badge set'
    badge.textContent = maskCredential(credential)
  } else {
    badge.className = 'badge none'
    badge.textContent = 'not set'
  }

  head.append(name, badge)

  const url = document.createElement('div')
  url.className = 'url'
  url.textContent = provider.baseUrl

  root.append(head, url)

  if (provider.requiresCredential) {
    const controls = document.createElement('div')
    controls.className = 'controls'

    const input = document.createElement('input')
    input.type = 'password'
    input.placeholder = credential ? 'replace key…' : `${provider.credentialName}…`
    input.autocomplete = 'off'

    const save = document.createElement('button')
    save.className = 'chip'
    save.type = 'button'
    save.textContent = 'Save'
    save.addEventListener('click', async () => {
      const value = input.value.trim()
      if (!value) return
      await setCredential(provider.id, value)
      input.value = ''
      await refresh()
    })

    controls.append(input, save)

    if (credential) {
      const clear = document.createElement('button')
      clear.className = 'chip'
      clear.type = 'button'
      clear.textContent = 'Clear'
      clear.addEventListener('click', async () => {
        await clearCredential(provider.id)
        await refresh()
      })
      controls.append(clear)
    }

    root.append(controls)
  }

  if (provider.note) {
    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = provider.note
    root.append(note)
  }

  return root
}

function renderStatus(
  providerId: string,
  modelId: string,
  keys: Map<string, string | undefined>,
): void {
  const provider = getProvider(providerId)
  if (!provider) {
    statusEl.textContent = `Unknown provider ${providerId}.`
    return
  }

  if (!usable(provider, keys.get(provider.id))) {
    statusEl.textContent = `${provider.label} needs a key before it can be used. Add one below.`
    return
  }

  const model = MODELS.find((m) => m.provider === providerId && m.id === modelId)
  const levels = thinkingLevelsFor(model)
  const thinking = !model
    ? ''
    : canDisableThinking(model)
      ? ' Reasoning can be switched off for faster turns.'
      : levels.length
        ? ` Reasoning cannot be switched off here — “${levels[0]}” is the cheapest setting.`
        : ' Reasoning is not adjustable on this model.'
  const modalities = model
    ? ` Takes ${model.input.join(', ')}; returns ${model.output.join(', ')}.`
    : ''
  statusEl.textContent =
    `Ready — ${provider.label} · ${model?.label ?? modelId}.${modalities}${thinking}`
}
