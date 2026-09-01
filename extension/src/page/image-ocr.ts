/**
 * Layer 3 for pixels: text that exists only inside an image.
 *
 * A photographed ID card, a scanned statement, a screenshot pasted into a page — none of it
 * has a DOM node, so layer 1 sees no field and layer 2 finds no text to measure. It is
 * visible in exactly one place, the capture, and OCR is the only way to locate it.
 *
 * Locate, not read: the point is a bounding box to paint over. What the words say matters
 * only insofar as the rules and the model decide whether the box is needed.
 *
 * Like the text NER, this must never take the scan down with it. Tesseract fetches its
 * worker and language data over the network, and a page that blocks that should cost the
 * text inside its images and nothing else.
 */

import { findPii, type Match } from '../shared/detect'
import { findNerPiiBatch } from '../shared/ner'
import type { Bounds } from '../shared/types'

/** Below this an image is an icon or a spacer, not something carrying a document. */
const MIN_IMAGE_SIZE = 50

/** OCR is the most expensive thing here by an order of magnitude; bound it explicitly. */
const MAX_IMAGES = 4

/** Enough words to be a sentence rather than a caption — the same gate the DOM text uses. */
const MIN_WORDS_FOR_MODEL = 4

interface Word {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

interface Line {
  text: string
  words: Word[]
  /** Which image this came from, so its boxes can be scaled back to the page. */
  image: number
}

type Worker = {
  recognize: (
    image: string,
    options?: unknown,
    output?: unknown,
  ) => Promise<{ data: { blocks?: unknown[] } }>
}

let worker: Promise<Worker | null> | null = null

/** Loaded once. A failure is remembered, so a blocked CDN is not retried every scan. */
async function getWorker(): Promise<Worker | null> {
  if (!worker) {
    worker = (async () => {
      try {
        const { createWorker } = await import('tesseract.js')
        return (await createWorker('eng')) as unknown as Worker
      } catch (err) {
        console.warn('[aegis] OCR unavailable, images will not be inspected:', err)
        return null
      }
    })()
  }
  return worker
}

/**
 * Which words a match covers.
 *
 * The previous shape ran the detectors on each word separately, which cannot work: an
 * Aadhaar is written "2345 6789 0124", and no single word of it is an Aadhaar. The line is
 * matched as a whole, then character offsets are walked back onto the words that compose
 * it, so a match spanning three words masks all three.
 */
function wordsCovering(line: Line, matches: readonly Match[]): Word[] {
  const covered: Word[] = []
  let cursor = 0

  for (const word of line.words) {
    // Tesseract's line text is its words joined by single spaces; find each in order so an
    // irregular gap cannot desynchronise the offsets.
    const at = line.text.indexOf(word.text, cursor)
    if (at < 0) continue

    const start = at
    const end = at + word.text.length
    cursor = end

    if (matches.some((m) => m.start < end && m.end > start)) covered.push(word)
  }

  return covered
}

export interface OcrResult {
  regions: Bounds[]
}

export async function scanImagesForPii(): Promise<OcrResult> {
  const images = [...document.querySelectorAll('img')]
    .filter((img) => {
      const rect = img.getBoundingClientRect()
      return rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE
    })
    .slice(0, MAX_IMAGES)

  if (!images.length) return { regions: [] }

  const engine = await getWorker()
  if (!engine) return { regions: [] }

  // --- read every image first, so the model can be called once for all of them ----------
  const lines: Line[] = []

  for (const [index, img] of images.entries()) {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth || img.width
      canvas.height = img.naturalHeight || img.height
      if (!canvas.width || !canvas.height) continue

      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

      let dataUrl: string
      try {
        dataUrl = canvas.toDataURL('image/jpeg')
      } catch {
        // A cross-origin image taints the canvas. Nothing can be read, and that is the
        // browser's decision rather than a failure to handle.
        continue
      }

      const { data } = await engine.recognize(dataUrl, {}, { text: true, blocks: true })

      for (const block of (data.blocks ?? []) as { paragraphs?: unknown[] }[]) {
        for (const para of (block.paragraphs ?? []) as { lines?: unknown[] }[]) {
          for (const line of (para.lines ?? []) as { text: string; words?: Word[] }[]) {
            const text = line.text.trim()
            if (text.length < 10) continue
            lines.push({ text, words: line.words ?? [], image: index })
          }
        }
      }
    } catch (err) {
      console.warn('[aegis] OCR failed for an image:', err)
    }
  }

  if (!lines.length) return { regions: [] }

  // --- one model call for every line across every image ---------------------------------
  const prose = lines
    .map((line, i) => (line.text.split(/\s+/).length >= MIN_WORDS_FOR_MODEL ? i : -1))
    .filter((i) => i >= 0)

  const nerByLine = new Map<number, Match[]>()
  if (prose.length) {
    const results = await findNerPiiBatch(prose.map((i) => lines[i].text))
    prose.forEach((lineIndex, n) => nerByLine.set(lineIndex, results[n] ?? []))
  }

  // --- map the covered words back onto the page -------------------------------------------
  const regions: Bounds[] = []

  for (const [i, line] of lines.entries()) {
    const matches = [...findPii(line.text), ...(nerByLine.get(i) ?? [])]
    if (!matches.length) continue

    const img = images[line.image]
    const rect = img.getBoundingClientRect()
    // The image is laid out at a different size from its intrinsic pixels, and OCR boxes are
    // in intrinsic pixels — so every box is scaled by the ratio between them.
    const scaleX = rect.width / (img.naturalWidth || rect.width)
    const scaleY = rect.height / (img.naturalHeight || rect.height)

    for (const word of wordsCovering(line, matches)) {
      const x = rect.left + word.bbox.x0 * scaleX
      const y = rect.top + word.bbox.y0 * scaleY
      const width = (word.bbox.x1 - word.bbox.x0) * scaleX
      const height = (word.bbox.y1 - word.bbox.y0) * scaleY
      if (width <= 0 || height <= 0) continue

      regions.push({
        x,
        y,
        width,
        height,
        documentX: x + window.scrollX,
        documentY: y + window.scrollY,
      })
    }
  }

  return { regions }
}
