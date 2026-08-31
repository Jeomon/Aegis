# Aegis

On-device visual perception for lightweight browser agents.

A Chrome side-panel extension that reads the page it is sitting next to, builds a compact
description of what can actually be interacted with, sends that to a vision-language model,
and executes the UI actions the model returns.

Built for **SIH26171** (ISRO, Software) by Team Aetheris, IIT Madras BS Degree Programme.

---

## Status

The agent loop runs end to end: the page is scanned, an observation is sent, tool calls come
back, and actions are executed against the live tab.

**The on-device redaction cascade is not implemented.** It is specified in
[`docs/redaction-pipeline.md`](docs/redaction-pipeline.md) and the seam for it exists in
`agent/agent.ts`, between `captureScreenshot()` and `annotateScreenshot()`. Until it is
built, the screenshot observation modes send unredacted pixels, and the settings panel says
so rather than pretending otherwise.

Layer 1 of the cascade — DOM rules — is implemented for the text channel. A field the page
declares sensitive (`type="password"`, `autocomplete="cc-number"`, an Aadhaar label) reports
`value=[redacted:kind]` instead of its contents, so the agent still knows the field is
filled without being told what with. The classification lives on each element, so the pixel
channel will mask the same decision rather than a parallel one.

Layer 2 — regex with checksums — covers the text those rules cannot reach: accessible
names, field values with no declared kind, the page title and URL, and every open tab's
title and URL. Aadhaar is validated with Verhoeff, cards with Luhn, GSTIN by the PAN
embedded in it, so an order number or a timestamp is left alone. Only the matched
substring is replaced, because the surrounding sentence is the context the server is being
asked to reason about.

In the screenshot, fields carrying personal data are painted out — opaque, never blurred,
since blur is reversible under super-resolution — and dilated by 3px because anti-aliased
glyph edges bleed outside their measured box. Masks are drawn in the same canvas pass as
the `[id]` labels and before them, so a label is never covered and the two can never
disagree about where an element is. The count is reported to the model, so a black
rectangle reads as a deliberate mask rather than a rendering failure to work around.

Still unredacted: text rendered into the page itself rather than into a field, faces, and
`evaluate` output.

---

## How it works

```
content script          side panel                      provider
─────────────────────────────────────────────────────────────────
scan the DOM      ─┐
  shadow-piercing  │
  accessible names ├──▶ observation ──▶ chat request ──▶ model
  occlusion tests  │    (+ screenshot)                     │
  numbered [id]s  ─┘                                       │
                                                           ▼
execute action    ◀───  browser tool  ◀───  tool call  ◀───┘
  click/type/scroll
```

Each turn sends the current page state and receives at most one tool call. The loop ends
when the model's **stop reason** says the turn is over — not when a step counter runs out,
which produced misleading "stopped after N steps" endings.

### Observation modes

| Mode | What the model receives | Requires |
|---|---|---|
| `tree` | the numbered element tree as text | nothing |
| `screenshot` | an annotated capture with `[id]` boxes | image input |
| `both` | the tree and the capture | image input |

Modes needing pixels are unselectable for a text-only model, and `resolveTarget()` enforces
that again at request time so a stale setting cannot leak a screenshot to a model that would
discard it.

---

## Providers

376 models across 11 providers, in three wire formats:

| Dialect | Providers |
|---|---|
| `openai` | OpenAI, NVIDIA NIM, OpenRouter, Together, Groq, Mistral, Cerebras, Ollama, vLLM |
| `anthropic` | Anthropic |
| `gemini` | Google Gemini |

Each dialect is contained in its own module under `providers/` and converts to one
internal `ChatResult`, so the agent loop cannot tell which provider answered.

> **On model choice for SIH26171.** The problem statement asks for an offline-deployable
> (open-weights) server model; a hosted copy of it is acceptable during the event. That is
> not enforced in code, so whoever selects the model is responsible for checking it.
> Mistral's Apache-2.0 models satisfy it; OpenAI, Anthropic and Gemini do not.

---

## Running it

```sh
cd extension
npm install
npm run build
```

Then load it in Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `extension/dist`
3. Click the Aegis icon to open the side panel

Requires Chrome 114 or later for the side panel API.

### Credentials

Keys live in `chrome.storage.local`, never in the build — an unpacked extension is readable
by anyone who installs it, so a key compiled into the bundle is a published key. Set one
from the panel:

```
key nvidia nvapi-xxxxxxxx
config
```

`.env` is for a future server component only; the extension does not read it.

---

## Layout

Code is grouped by *where it runs*, because that boundary decides what ships into every
page you visit. Everything under `page/` and `shared/` is bundled into the content script
and executes on every site; everything else stays in the side panel. The build enforces
nothing, but the import graph makes a violation obvious.

```
extension/src/
  background.ts  content.ts  sidepanel.ts   the three entry points

  page/          bundled into content.js — runs on every site
    scan.ts        walk the DOM, pierce shadow roots, decide what is interactive
    accname.ts     accessible names, following the ARIA precedence order
    roles.ts       implicit ARIA roles by tag
    tree.ts        structural scaffolding around the numbered elements
    execute.ts     click, type, scroll, wait — in the page

  observe/       what the model is shown
    observation.ts text rendering of the page state
    annotate.ts    draw [id] boxes onto a capture

  agent/
    agent.ts       the turn loop
    prompt.ts      the system prompt, assembled per turn
    tools.ts       the browser tool schema and validation
    browser.ts     navigation and tab actions, plus the tool dispatcher

  providers/
    chat.ts        OpenAI chat-completions, and the dialect switch
    anthropic.ts   Anthropic Messages
    gemini.ts      Gemini generateContent
    registry.ts    provider registry and capability checks
    catalogue.generated.ts   376 models, generated

  ui/
    settings-panel.ts  the settings tabs
    markdown.ts        render model output by building DOM nodes, never innerHTML
    describe.ts        tool activity cards
    command.ts         slash-style panel commands

  shared/
    actions.ts  types.ts  settings.ts

docs/
  redaction-pipeline.md   the cascade design, not yet implemented
```

Model output is attacker-influenced — the agent reads untrusted pages — and runs with
extension privileges, which is why rendering builds nodes rather than assigning HTML.

---

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run build       # side panel + content script
npm run watch       # rebuild on change
```

Verification is done with throwaway harnesses rather than a committed test suite: a
temporary `src/__verify_*.ts`, bundled with esbuild and run against stubbed transport, then
deleted. The Anthropic and Gemini dialects were each checked this way — conversion,
streaming, tool-call reassembly, stop-reason mapping and error paths — by stubbing `fetch`
so the real SDK code runs without a live key.
