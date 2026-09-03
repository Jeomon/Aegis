/**
 * Strip a model's own channel markers out of prose.
 *
 * Models trained on the "harmony" format separate their reasoning from their answer with
 * literal tokens — `<|channel|>`, `<|message|>`, `<|start|>` — and expect the harness to
 * consume them. When a provider streams the raw text instead of parsing it, those tokens
 * arrive as content and get rendered, so the panel shows `<|channel|>thought` above the
 * reply. They are not part of the answer and were never meant to be read.
 *
 * The malformed spellings are deliberate: a token split across two stream chunks and
 * reassembled loses a bar often enough to be worth matching, and `<|channel>` is not text
 * anyone writes on purpose.
 */
const CONTROL_TOKEN = /<\|?(?:channel|message|start|end|return|constrain|assistant|system|user)\|?>/gi

/**
 * A channel marker and the name that follows it, taken together.
 *
 * The name has to go with the token that introduces it or it is left welded to the prose —
 * `<|channel|>analysis<|message|>Some reasoning` becomes `analysisSome reasoning`. Matching
 * the name only in this position is what keeps an ordinary sentence safe: "this is the
 * final answer" has no marker in front of it, so nothing matches.
 */
const CHANNEL_WITH_NAME =
  /<\|?channel\|?>[ \t]*(?:thought|thinking|analysis|commentary|final)?/gi

export function stripControlTokens(text: string): string {
  if (!text.includes('<|') && !text.includes('|>')) return text
  return text
    .replace(CHANNEL_WITH_NAME, '')
    .replace(CONTROL_TOKEN, '')
    .replace(/^\s+/, '')
}
