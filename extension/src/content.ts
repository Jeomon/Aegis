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
import { EGRESS_MESSAGE, installEgressGuard, onEgress } from './observe/redact/egress'
import { conceal } from './page/vault'
import { redactText } from './shared/detect'
import { scanImagesForPii } from './page/image-ocr'
import type { ScanResult } from './shared/types'

async function scan(): Promise<ScanResult> {
  const started = performance.now()

  // This frame plus every frame it embeds: elements, their tree, and the regions to paint
  // out — all already translated into this frame's coordinates.
  const { elements, roots, regions: piiRegions, counts } = await collectFrame()

  // Text found inside images, which no DOM layer can reach.
  const ocr = await scanImagesForPii()
  const allRegions = [...piiRegions, ...ocr.regions]

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
    piiRegions: allRegions,
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

/**
 * The content script does its own egress now, because layer 3 fetches model weights from
 * here rather than from the panel. A guard installed only in the panel would have left that
 * unwatched — and the panel says it shows every request the extension makes.
 *
 * Wrapping fetch here touches the isolated world only; the page's own fetch is untouched.
 * Records are forwarded so one panel shows both contexts.
 */
installEgressGuard()
onEgress((entry) => {
  // The panel may not be open. Nothing depends on delivery, so a failure is ignored.
  void chrome.runtime.sendMessage({ type: EGRESS_MESSAGE, entry }).catch(() => {})
})
