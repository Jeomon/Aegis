/**
 * Nesting and rendering.
 *
 * Interactive elements alone almost never nest — a `<nav>` is not clickable, so its links
 * would all become roots and the "tree" would be a flat list. Web-Use solves this by
 * scaffolding the tree with structural containers, which is what conveys page structure to
 * a model: a form over its fields, a nav over its links, a list over its items.
 *
 * Containers are unnumbered. Only elements carry an `[id]`, so the addressing the action
 * layer depends on is unchanged.
 */

import { parentOf } from './scan'
import type { InteractiveElement, TreeNode } from '../types'

const MAX_LINES = 150

/** Tags worth showing as scaffolding when they sit above something interactive. */
const STRUCTURAL_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  'nav', 'header', 'footer', 'main', 'section', 'article',
  'form', 'ul', 'ol', 'li', 'aside', 'dialog', 'fieldset', 'details',
  'table', 'thead', 'tbody', 'tfoot', 'tr',
])

function containerName(el: Element): string {
  const label = el.getAttribute('aria-label')?.trim()
  if (label) return label.replace(/\s+/g, ' ').slice(0, 60)

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const target = document.getElementById(labelledBy.split(/\s+/)[0])
    const text = target?.textContent?.replace(/\s+/g, ' ').trim()
    if (text) return text.slice(0, 60)
  }
  return ''
}

/**
 * Build the forest: every kept element, plus any structural container standing between one
 * of them and the document root.
 */
export function buildTree(
  elements: InteractiveElement[],
  byId: Map<number, Element>,
): TreeNode[] {
  const nodes = new Map<Element, TreeNode>()

  for (const element of elements) {
    const el = byId.get(element.id)
    if (el) nodes.set(el, { kind: 'element', element, children: [] })
  }

  // Walk up from each element registering structural containers, stopping at the first
  // ancestor already in the map — everything above it is already accounted for.
  for (const el of [...nodes.keys()]) {
    for (let cur = parentOf(el); cur; cur = parentOf(cur)) {
      if (nodes.has(cur)) break
      const tag = cur.tagName.toLowerCase()
      if (STRUCTURAL_CONTAINER_TAGS.has(tag)) {
        nodes.set(cur, { kind: 'container', tag, name: containerName(cur), children: [] })
      }
    }
  }

  // Document order, so children are appended to a parent in the order they appear.
  const ordered = [...nodes.keys()].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  )

  const roots: TreeNode[] = []
  for (const el of ordered) {
    const node = nodes.get(el)!
    let parent: TreeNode | undefined
    for (let cur = parentOf(el); cur; cur = parentOf(cur)) {
      const found = nodes.get(cur)
      if (found) {
        parent = found
        break
      }
    }
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  return roots
}

/** One `[id] role "name" [states] (flags)` line, or a bare container tag. */
export function formatLine(node: TreeNode): string {
  if (node.kind === 'container') {
    return node.name ? `${node.tag} ${JSON.stringify(node.name)}` : node.tag
  }

  const { element } = node
  const states = element.states.length ? ` [${element.states.join(', ')}]` : ''

  const flags: string[] = []
  if (element.scrollable) flags.push('scrollable')
  if (element.shadow) flags.push('shadow')
  const flagText = flags.length ? ` (${flags.join(', ')})` : ''

  return `[${element.id}] ${element.role} ${JSON.stringify(element.name)}${states}${flagText}`
}

/** The forest as an indented outline, capped so a huge page cannot flood the panel. */
export function renderTree(roots: TreeNode[], maxLines = MAX_LINES): string {
  const lines: string[] = []
  let dropped = 0

  const countNodes = (node: TreeNode): number =>
    1 + node.children.reduce((total, child) => total + countNodes(child), 0)

  const walk = (node: TreeNode, depth: number): void => {
    if (lines.length >= maxLines) {
      dropped += countNodes(node)
      return
    }
    lines.push('  '.repeat(depth) + formatLine(node))
    for (const child of node.children) walk(child, depth + 1)
  }

  for (const root of roots) walk(root, 0)
  if (dropped > 0) lines.push(`… and ${dropped} more (scroll to see them)`)

  return lines.join('\n')
}
