/**
 * Layer 3 for text: a model, for the entities no pattern can anchor.
 *
 * Layers 1 and 2 cover everything declared or structured — a password field, an Aadhaar
 * that satisfies Verhoeff. What neither reaches is a name or an address written into
 * ordinary prose: "transfer to Ravi Menon in Kochi" has no attribute and no checksum. That
 * gap, and only that gap, is what this is for.
 *
 * Three things follow from being a model rather than a rule, and each is handled here
 * rather than by the caller:
 *
 * It can fail. The weights come over the network, so an offline browser, a blocked CDN or a
 * strict page CSP all mean no model. That must cost the entities it would have found and
 * nothing else — never the scan, and never the agent's view of the page.
 *
 * It is slow. Even a small model is orders of magnitude slower than a regex, so it runs on
 * prose the cheap layers left unexplained rather than over every string on the page.
 *
 * It is uncertain. A confidence floor, a length floor and a word-boundary match keep it from
 * redacting text the server legitimately needs, because precision is scored and a mask over
 * ordinary words costs twice — once in precision, once in the context it destroys.
 */

import type { Match } from './detect'
import type { SensitiveKind } from './types'

/**
 * PII-specific, and small: four layers at 512 hidden, 28.7 MB quantised, Apache-2.0.
 *
 * The obvious alternative, bert-base-NER, is 109 MB and 157 ms per string against this
 * model's 6.4 ms — measured, not assumed — and it is trained on newswire, so it reads a
 * field label as an organisation. This one is trained on personal data, which is the task.
 *
 * Note the repository: gravitee-io's own copy ships model.quant.onnx at the root, and
 * transformers.js looks for onnx/model_quantized.onnx. The ONNX-community conversion has
 * the layout the library expects.
 */
const MODEL = 'onnx-community/bert-small-pii-detection-ONNX'

/**
 * Only the entities regex genuinely cannot reach.
 *
 * ORGANIZATION is deliberately absent. Every NER treats a short uppercase token as an
 * acronym for a company, so it turns the label "CVV" into a redaction — measured on both
 * models. We are looking for people and places; a company name is not personal data, and
 * accepting it buys nothing while costing the field labels the agent needs to read.
 */
const ACCEPTED: Record<string, SensitiveKind> = {
  PERSON: 'name',
  PER: 'name',
  LOCATION: 'street-address',
  LOC: 'street-address',
}

/**
 * Deliberately high, and measured rather than chosen.
 *
 * On this model a real entity comes back at 0.99–1.00 — "Ravi Menon" scored 1.00, "Kochi"
 * 0.99 — while the word "Decoys" in a section heading scored 0.75 and was masked on screen.
 * There is a wide gap between the two, so the floor sits in it.
 *
 * Recall on names is the thing to trade away here. A missed name is a gap we already
 * declare; a black rectangle over an ordinary word costs precision, which is scored, and
 * destroys the context the server is being asked to read, which is scored separately.
 */
const MIN_SCORE = 0.9
const MIN_LENGTH = 3

type Token = { entity: string; word: string; score: number }
type Pipeline = (texts: string[], options?: unknown) => Promise<unknown>

let loading: Promise<Pipeline | null> | null = null

/**
 * Load once, and remember a failure as a failure.
 *
 * Without the null cache a blocked CDN is retried on every scan, so the cost of not having
 * the model is paid over and over — the worst of both outcomes.
 */
async function getPipeline(): Promise<Pipeline | null> {
  if (!loading) {
    loading = (async () => {
      try {
        // Imported lazily so the 800 kB library is not parsed on pages that never reach a
        // text node worth classifying.
        const { pipeline } = await import('@xenova/transformers')
        return (await pipeline('token-classification', MODEL)) as unknown as Pipeline
      } catch (err) {
        console.warn('[aegis] NER unavailable, continuing with rules only:', err)
        return null
      }
    })()
  }
  return loading
}

/** Is the model available? Lets a caller skip the work of preparing input it cannot use. */
export async function nerAvailable(): Promise<boolean> {
  return (await getPipeline()) !== null
}

/**
 * Group the model's subword tokens back into whole entities.
 *
 * BERT emits "Ravi", "Men", "##on" — three tokens for two words. Anything that reads them
 * individually redacts fragments, which is both wrong and conspicuous on screen.
 */
function entitiesOf(tokens: Token[]): { kind: SensitiveKind; word: string }[] {
  const entities: { kind: SensitiveKind; word: string }[] = []
  let word = ''
  let kind: SensitiveKind | null = null

  const flush = (): void => {
    if (kind && word.length >= MIN_LENGTH) entities.push({ kind, word })
    word = ''
    kind = null
  }

  for (const token of tokens) {
    if (token.score < MIN_SCORE) continue

    const subword = token.word.startsWith('##')
    const part = subword ? token.word.slice(2) : token.word
    const next = ACCEPTED[token.entity.split('-').pop() ?? ''] ?? null

    if (next === null) {
      flush()
      continue
    }
    if (next !== kind) {
      flush()
      kind = next
      word = part
    } else {
      word += subword ? part : ` ${part}`
    }
  }
  flush()

  return entities
}

/** Where the entity actually sits in the text, on whole-word boundaries only. */
function locate(text: string, word: string, kind: SensitiveKind): Match[] {
  // The tokenizer lowercases and splits, so the entity is matched back case-insensitively
  // with flexible whitespace — OCR in particular breaks lines mid-phrase.
  const pattern = word
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')

  let regex: RegExp
  try {
    regex = new RegExp(`\\b${pattern}\\b`, 'gi')
  } catch {
    return []
  }

  const found: Match[] = []
  for (const m of text.matchAll(regex)) {
    found.push({ start: m.index, end: m.index + m[0].length, text: m[0], kind })
  }
  return found
}

/**
 * Classify a batch in one call.
 *
 * One call rather than one per string: the per-call overhead dominates for short inputs,
 * and running a pipeline per DOM node is what makes a page appear to freeze.
 *
 * Returns one array per input, empty where the model found nothing — or where there is no
 * model, so a caller can merge the result without checking whether it ran.
 */
export async function findNerPiiBatch(texts: string[]): Promise<Match[][]> {
  if (!texts.length) return []

  const pipe = await getPipeline()
  if (!pipe) return texts.map(() => [])

  let raw: unknown
  try {
    raw = await pipe(texts, { ignore_labels: [] })
  } catch (err) {
    console.warn('[aegis] NER inference failed, continuing with rules only:', err)
    return texts.map(() => [])
  }

  // A single input may come back as a bare token array rather than an array of arrays.
  const rows = (Array.isArray(raw) && Array.isArray((raw as unknown[])[0])
    ? raw
    : [raw]) as Token[][]

  return texts.map((text, i) =>
    entitiesOf(rows[i] ?? []).flatMap((entity) => locate(text, entity.word, entity.kind)),
  )
}
