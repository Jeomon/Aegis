/**
 * Content script. Runs in the page and answers two things: scan requests with the
 * interactive element tree, and action requests addressed by scan id.
 *
 * Both live in the same script instance deliberately — the id registry is module state
 * here, so an action can only resolve ids produced by a scan in this same instance.
 */

import { ACT_MESSAGE } from './shared/actions'
import type { ActMessage } from './shared/actions'
import { collectFrame, dispatchAction, installFrameResponder } from './page/frames'
import { conceal } from './page/vault'
import { redactText } from './shared/detect'
import type { ScanResult } from './shared/types'

async function scan(): Promise<ScanResult> {
  const started = performance.now()

  // This frame plus every frame it embeds: elements, their tree, and the regions to paint
  // out — all already translated into this frame's coordinates.
  const { elements, roots, regions: piiRegions, counts } = await collectFrame()

  return {
    elements,
    roots,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    // Redacted at source rather than at render time, so an identifier in a URL or a title
    // never crosses out of the page in the first place. It shares the vault with the
    // fields, so the same Aadhaar in the title and in an input is one handle, not two.
    url: redactText(location.href, conceal).text,
    title: redactText(document.title, conceal).text,
    piiRegions,
    scanMs: Math.round(performance.now() - started),
    counts,
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'AEGIS_SCAN') {
    scan().then(sendResponse).catch(() => sendResponse(undefined))
    return true // asking the child frames makes this asynchronous
  }

  if (message?.type === ACT_MESSAGE) {
    const { action } = message as ActMessage

    // An id belonging to a frame we embed is routed there; dispatchAction handles both
    // cases, and keeps routing at every hop rather than only the first.
    dispatchAction(action)
      .then(sendResponse)
      .catch((err: unknown) =>
        sendResponse({ ok: false, message: err instanceof Error ? err.message : String(err) }),
      )
    return true // response is async
  }
})

// Every frame answers its parent; only the top frame is ever asked to scan, because only
// it has a screenshot to align with.
installFrameResponder()
