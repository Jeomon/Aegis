/**
 * Layer 2 of the redaction cascade: find personal identifiers in free text.
 *
 * The checksums are the entire point. A bare twelve-digit pattern fires on order numbers,
 * timestamps and tracking IDs, and every one of those is a precision loss on text the
 * server legitimately needs. Verhoeff cuts Aadhaar false positives to near zero, Luhn does
 * the same for cards, and GSTIN carries a PAN inside it that must itself be well formed.
 *
 * No model is involved, and none would do better here: these formats are defined by an
 * algorithm, not by a distribution. A detector trained on US English data fumbles all of
 * them.
 *
 * Matches are returned as spans so the caller can mask the substring rather than the whole
 * string — "Your PAN is ABCDE1234F" should lose ten characters, not the sentence, because
 * the surrounding text is the context the server is being asked to reason about.
 */

import type { SensitiveKind } from './types'

export interface Match {
  start: number
  end: number
  text: string
  kind: SensitiveKind
}

// ---------------------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------------------

/** Dihedral group D5 multiplication, permutation, and inverse tables. */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

/** UIDAI's own check: the Verhoeff checksum over all twelve digits must come to zero. */
export function verhoeff(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false

  let c = 0
  const reversed = [...digits].reverse()
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(reversed[i])]]
  }
  return c === 0
}

export function luhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false

  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i])
    if (double) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    double = !double
  }
  return sum % 10 === 0
}

/**
 * The fourth character of a PAN encodes the holder type — P for an individual, C for a
 * company, and so on. Anything outside that set is a string that merely looks like a PAN.
 */
const PAN_ENTITY_TYPES = new Set([...'ABCFGHJLPTKE'])

export function validPan(text: string): boolean {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(text) && PAN_ENTITY_TYPES.has(text[3])
}

/** State codes run 01–38, plus 97 for "other territory" and 99 for centre jurisdiction. */
function validStateCode(code: string): boolean {
  const n = Number(code)
  return (n >= 1 && n <= 38) || n === 97 || n === 99
}

export function validGstin(text: string): boolean {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(text)) return false
  return validStateCode(text.slice(0, 2)) && validPan(text.slice(2, 12))
}

// ---------------------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------------------

interface Detector {
  kind: SensitiveKind
  pattern: RegExp
  /** Given the raw match, decide whether it is genuinely an identifier of this kind. */
  accept?: (raw: string) => boolean
}

const digitsOf = (raw: string) => raw.replace(/\D/g, '')

/**
 * Order is significant where patterns nest. GSTIN must be tried before PAN because it
 * contains one, and card before Aadhaar because a 16-digit card would otherwise be cut
 * short by a 12-digit Aadhaar match.
 */
const DETECTORS: Detector[] = [
  {
    kind: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: 'gstin',
    pattern: /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g,
    accept: validGstin,
  },
  {
    kind: 'ifsc',
    // The fifth character is reserved and always zero, which is most of the specificity.
    pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
  },
  {
    kind: 'pan',
    pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    accept: validPan,
  },
  {
    kind: 'cc-number',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (raw) => {
      const digits = digitsOf(raw)
      return digits.length >= 13 && digits.length <= 19 && luhn(digits)
    },
  },
  {
    kind: 'aadhaar',
    // Never begins with 0 or 1, and is conventionally written in groups of four.
    pattern: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    accept: (raw) => verhoeff(digitsOf(raw)),
  },
  {
    kind: 'tel',
    // Indian mobiles are conventionally written with a break after five digits — "98765
    // 43210" — so demanding ten consecutive digits misses the format people actually use.
    // The leading digit is still 6-9, which is what keeps order numbers and epochs out.
    pattern: /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g,
    // A ten-digit run inside something longer is part of that longer thing, not a number.
    accept: (raw) => {
      const digits = digitsOf(raw)
      return digits.length === 10 || (digits.length === 12 && digits.startsWith('91'))
    },
  },
  {
    kind: 'date',
    pattern: /\b\d{1,2}[-/\s]\d{1,2}[-/\s]\d{2,4}\b/g,
  },
]

/**
 * Every identifier in the text, left to right and never overlapping.
 *
 * Where two detectors claim the same ground the earlier start wins, and on a tie the longer
 * match does — so a GSTIN is not reported as the PAN embedded inside it.
 */
export function findPii(text: string): Match[] {
  if (!text) return []

  const found: Match[] = []
  for (const detector of DETECTORS) {
    // Patterns carry /g and therefore lastIndex; reset so repeated calls behave.
    detector.pattern.lastIndex = 0
    for (const m of text.matchAll(detector.pattern)) {
      const raw = m[0]
      if (detector.accept && !detector.accept(raw)) continue
      found.push({ start: m.index, end: m.index + raw.length, text: raw, kind: detector.kind })
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end)

  const kept: Match[] = []
  let consumed = -1
  for (const match of found) {
    if (match.start < consumed) continue
    kept.push(match)
    consumed = match.end
  }
  return kept
}

/**
 * Replace every identifier in the text with a marker, leaving the rest intact.
 *
 * `conceal` is supplied where a value should stay recoverable — in the page, where the
 * agent may need to type it back. Without it the value is simply dropped, which is right
 * for a tab title or a URL that nobody will ever be asked to re-enter.
 */
export function redactText(
  text: string,
  conceal?: (kind: SensitiveKind, value: string) => string,
  extraMatches: Match[] = []
): { text: string; kinds: SensitiveKind[] } {
  let matches = [...findPii(text), ...extraMatches]
  if (!matches.length) return { text, kinds: [] }

  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  
  const kept: Match[] = []
  let consumed = -1
  for (const match of matches) {
    if (match.start < consumed) continue
    kept.push(match)
    consumed = match.end
  }
  matches = kept

  let out = ''
  let cursor = 0
  for (const match of matches) {
    out += text.slice(cursor, match.start)
    out += conceal ? conceal(match.kind, match.text) : `[redacted:${match.kind}]`
    cursor = match.end
  }
  out += text.slice(cursor)

  return { text: out, kinds: matches.map((m) => m.kind) }
}
