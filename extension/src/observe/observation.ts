/**
 * The message a model sees each turn.
 *
 * Mirrors browser_use's state.py: a short factual summary (tabs, page, viewport) followed
 * by the interactive tree. In browser_use this is injected ephemerally via the "context"
 * hook so it is never written to history — the model always sees the current page rather
 * than a stale snapshot. The same discipline applies here: rebuild it every turn, never
 * append it to the transcript.
 */

import { redactText } from '../shared/detect'
import { renderTree } from '../page/tree'
import type { TabInfo } from '../agent/browser'
import type { ScanResult } from '../shared/types'

const TREE_HEADING =
  'Interactive elements (role "name" [states]; indented by nesting; act on them by elementId):'

export function renderObservation(
  scan: ScanResult,
  tabs: TabInfo[] = [],
  includeTree = true,
): string {
  const parts = [summary(scan, tabs)]

  // In screenshot-only mode the ids come from the labels drawn on the image, so repeating
  // the whole tree would just duplicate them at considerable token cost.
  if (!includeTree) {
    parts.push(
      `${scan.elements.length} interactive elements are labelled on the screenshot; act on ` +
        'them by the number shown in each box.',
    )
    return parts.join('\n\n')
  }

  const tree = renderTree(scan.roots)
  if (tree) parts.push(`${TREE_HEADING}\n${tree}`)
  else parts.push('No interactive elements are visible on this page.')

  if (scan.pageText) {
    parts.push(`Page Content (Unstructured Text):\n${scan.pageText}`)
  }

  return parts.join('\n\n')
}

/**
 * Layer 2 over the page and tab headers.
 *
 * These are the panel's own data rather than the page's, so they never reach the vault —
 * an identifier in a tab title is not something the agent will be asked to type back, and
 * a handle nobody can expand is just noise. It is dropped instead.
 *
 * Worth noting how much this covers: every open tab is listed, so an unrelated Gmail tab
 * would otherwise contribute its subject line and URL to every single turn.
 */
function clean(text: string): string {
  return redactText(text ?? '').text
}

function summary(scan: ScanResult, tabs: TabInfo[]): string {
  const lines = ['Browser state:']

  if (tabs.length > 1) {
    lines.push('Tabs:')
    for (const tab of tabs) {
      lines.push(
        `${tab.active ? '*' : ' '} [${tab.tabId}] ${JSON.stringify(clean(tab.title))} ${clean(tab.url)}`,
      )
    }
  }

  lines.push(`Page: ${JSON.stringify(clean(scan.title))} — ${clean(scan.url)}`)

  const { width, height, scrollX, scrollY } = scan.viewport
  lines.push(`Viewport: ${width}x${height}, scrolled to (${Math.round(scrollX)}, ${Math.round(scrollY)})`)

  return lines.join('\n')
}
