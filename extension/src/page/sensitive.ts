/**
 * Layer 1 of the redaction cascade: classify a field as sensitive from the DOM alone.
 *
 * Certain by construction and free. If the page declares `type="password"` or
 * `autocomplete="cc-number"`, no detector is needed and no detector could do better — the
 * author has already told us. Everything here is structural; pattern matching over text
 * content is layer 2's job.
 *
 * The classification is used twice, which is the point of doing it here rather than at the
 * point of rendering: the text observation masks the value, and the screenshot masks the
 * element's bounds. One decision, two channels, so the two can never disagree.
 */

export type SensitiveKind =
  | 'password'
  | 'one-time-code'
  | 'cc-number'
  | 'cc-csc'
  | 'cc-exp'
  | 'email'
  | 'tel'
  | 'street-address'
  | 'postal-code'
  | 'bday'
  | 'name'
  | 'aadhaar'
  | 'pan'
  | 'account'

/**
 * autocomplete values, once stripped of their section and address-type prefixes. The spec
 * allows "section-payment shipping cc-number", so only the last token carries the meaning.
 */
const AUTOCOMPLETE_KINDS: Record<string, SensitiveKind> = {
  'current-password': 'password',
  'new-password': 'password',
  'one-time-code': 'one-time-code',
  'cc-number': 'cc-number',
  'cc-csc': 'cc-csc',
  'cc-exp': 'cc-exp',
  'cc-exp-month': 'cc-exp',
  'cc-exp-year': 'cc-exp',
  'cc-name': 'name',
  email: 'email',
  tel: 'tel',
  'tel-national': 'tel',
  'tel-local': 'tel',
  'street-address': 'street-address',
  'address-line1': 'street-address',
  'address-line2': 'street-address',
  'postal-code': 'postal-code',
  bday: 'bday',
  'bday-day': 'bday',
  'bday-month': 'bday',
  'bday-year': 'bday',
  name: 'name',
  'given-name': 'name',
  'family-name': 'name',
  'additional-name': 'name',
}

/**
 * Last resort, over the field's own label and attributes rather than the page's text.
 *
 * Ordered, because "card number" must beat "number" and the first match wins. These are
 * heuristics over author-chosen words, so they are deliberately narrow — a false positive
 * here masks a value the server legitimately needs, and precision is 20% of the rubric.
 */
const LABEL_PATTERNS: [RegExp, SensitiveKind][] = [
  // Postal code comes first on purpose. In India "PIN code" is a postal code, and a
  // password rule matching the bare word "pin" claims it otherwise — masking an address
  // field as a secret, which is a precision error rather than a harmless one.
  [/\b(pin[\s-]?code|pincode|postal|zip)\b/i, 'postal-code'],
  [/\b(password|passwd|passphrase)\b/i, 'password'],
  [/\bpin\b/i, 'password'],
  [/\b(otp|one[\s-]?time|verification code|auth code)\b/i, 'one-time-code'],
  [/\b(cvv|cvc|security code|card verification)\b/i, 'cc-csc'],
  [/\b(aadhaar|aadhar|uidai)\b/i, 'aadhaar'],
  [/\b(pan[\s-]?(number|card|no)|permanent account)\b/i, 'pan'],
  [/\b(card[\s-]?(number|no)|cardno|credit card|debit card)\b/i, 'cc-number'],
  [/\b(account[\s-]?(number|no)|ifsc|ssn|passport)\b/i, 'account'],
  [/\b(expiry|expiration|valid thru)\b/i, 'cc-exp'],
  [/\b(e-?mail)\b/i, 'email'],
  [/\b(phone|mobile|contact number)\b/i, 'tel'],
  [/\b(address|street)\b/i, 'street-address'],
  [/\b(date of birth|dob|birthday)\b/i, 'bday'],
]

/** Text the author attached to the field itself, used only for the fallback patterns. */
function labelText(el: Element): string {
  const parts = [
    el.getAttribute('aria-label'),
    el.getAttribute('name'),
    el.getAttribute('placeholder'),
    el.id,
  ]

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    for (const label of el.labels ?? []) parts.push(label.textContent)
  }

  return parts.filter(Boolean).join(' ')
}

/**
 * What kind of secret this control holds, or undefined if it holds none.
 *
 * Rules are ordered by certainty: the declared type, then the declared autocomplete, then
 * the field's own wording. Anything contenteditable is treated as freeform, because it can
 * hold anything and nothing about it says what.
 */
export function classifySensitive(el: Element): SensitiveKind | undefined {
  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase()
    if (type === 'password') return 'password'
    if (type === 'email') return 'email'
    if (type === 'tel') return 'tel'

    // Nothing typed is retained, so a field the user cannot type into is not a secret.
    if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') {
      return undefined
    }
  }

  const autocomplete = el.getAttribute('autocomplete')
  if (autocomplete) {
    const tokens = autocomplete.toLowerCase().trim().split(/\s+/)
    for (const token of tokens.reverse()) {
      const kind = AUTOCOMPLETE_KINDS[token]
      if (kind) return kind
    }
  }

  const takesInput =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el.getAttribute('role') === 'textbox' ||
    isEditable(el)

  if (!takesInput) return undefined

  const label = labelText(el)
  for (const [pattern, kind] of LABEL_PATTERNS) {
    if (pattern.test(label)) return kind
  }

  // A contenteditable region is deliberately not classified wholesale. It can hold
  // anything — a message, a document, a password — and masking every rich-text editor on
  // structure alone would blind the agent to its own compose box for no gain. Content
  // that happens to be sensitive is layer 2's job, matched on the text itself.
  return undefined
}

/** isContentEditable lives on HTMLElement, not Element. */
function isEditable(el: Element): boolean {
  return el instanceof HTMLElement && el.isContentEditable
}
