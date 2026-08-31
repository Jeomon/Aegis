/**
 * A small markdown renderer that builds DOM nodes and never touches innerHTML.
 *
 * That constraint is not fussiness. The model reads untrusted web pages, so its output is
 * attacker-influenced — a page can contain text engineered to make the model emit whatever
 * it likes. This renders inside an extension document, which has extension privileges, so
 * parsing markdown into an HTML string and assigning it would be a direct injection route.
 * Building elements and setting textContent cannot inject markup by construction.
 *
 * Covers what a chat reply actually uses: headings, emphasis, code, lists, links, quotes
 * and rules. Anything unrecognised falls through as literal text.
 */

/** Only these schemes may become a clickable link; anything else renders as plain text. */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:']

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^)\s]+\))/g

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw, 'https://invalid.example')
    return SAFE_SCHEMES.includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/** Emphasis, code spans and links within a single line. */
function renderInline(text: string, into: Node): void {
  let lastIndex = 0

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      into.appendChild(document.createTextNode(text.slice(lastIndex, index)))
    }

    const token = match[0]

    if (token.startsWith('`')) {
      const code = document.createElement('code')
      code.textContent = token.slice(1, -1)
      into.appendChild(code)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      const strong = document.createElement('strong')
      strong.textContent = token.slice(2, -2)
      into.appendChild(strong)
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const href = safeHref(token.slice(split + 2, -1))
      if (href) {
        const anchor = document.createElement('a')
        anchor.href = href
        anchor.target = '_blank'
        anchor.rel = 'noreferrer noopener'
        anchor.textContent = label || href
        into.appendChild(anchor)
      } else {
        into.appendChild(document.createTextNode(token))
      }
    } else {
      const em = document.createElement('em')
      em.textContent = token.slice(1, -1)
      into.appendChild(em)
    }

    lastIndex = index + token.length
  }

  if (lastIndex < text.length) {
    into.appendChild(document.createTextNode(text.slice(lastIndex)))
  }
}

const HEADING = /^(#{1,6})\s+(.*)$/
const UNORDERED = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const RULE = /^(-{3,}|\*{3,}|_{3,})$/

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const lines = source.split('\n')

  let index = 0
  while (index < lines.length) {
    const line = lines[index]

    // Fenced code — consumed verbatim, so nothing inside is interpreted.
    if (line.trimStart().startsWith('```')) {
      const language = line.trim().slice(3).trim()
      const body: string[] = []
      index++
      while (index < lines.length && !lines[index].trimStart().startsWith('```')) {
        body.push(lines[index])
        index++
      }
      index++ // closing fence, or end of input mid-stream

      const pre = document.createElement('pre')
      const code = document.createElement('code')
      if (language) code.dataset.language = language
      code.textContent = body.join('\n')
      pre.appendChild(code)
      fragment.appendChild(pre)
      continue
    }

    if (!line.trim()) {
      index++
      continue
    }

    if (RULE.test(line.trim())) {
      fragment.appendChild(document.createElement('hr'))
      index++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`)
      renderInline(heading[2], element)
      fragment.appendChild(element)
      index++
      continue
    }

    if (QUOTE.test(line)) {
      const quote = document.createElement('blockquote')
      const parts: string[] = []
      while (index < lines.length && QUOTE.test(lines[index])) {
        parts.push(QUOTE.exec(lines[index])![1])
        index++
      }
      renderInline(parts.join(' '), quote)
      fragment.appendChild(quote)
      continue
    }

    if (UNORDERED.test(line) || ORDERED.test(line)) {
      const ordered = !UNORDERED.test(line)
      const list = document.createElement(ordered ? 'ol' : 'ul')
      while (index < lines.length) {
        const match = ordered ? ORDERED.exec(lines[index]) : UNORDERED.exec(lines[index])
        if (!match) break
        const item = document.createElement('li')
        renderInline(match[1], item)
        list.appendChild(item)
        index++
      }
      fragment.appendChild(list)
      continue
    }

    // Paragraph: consecutive non-blank lines that start no other block.
    const paragraph = document.createElement('p')
    const parts: string[] = []
    while (index < lines.length) {
      const current = lines[index]
      if (
        !current.trim() ||
        current.trimStart().startsWith('```') ||
        HEADING.test(current) ||
        UNORDERED.test(current) ||
        ORDERED.test(current) ||
        QUOTE.test(current) ||
        RULE.test(current.trim())
      ) {
        break
      }
      parts.push(current)
      index++
    }
    renderInline(parts.join('\n'), paragraph)
    fragment.appendChild(paragraph)
  }

  return fragment
}

/** Replace an element's contents with rendered markdown. */
export function setMarkdown(target: Element, source: string): void {
  target.replaceChildren(renderMarkdown(source))
}
