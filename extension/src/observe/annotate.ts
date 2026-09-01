/**
 * Labelled bounding boxes drawn onto a screen capture.
 *
 * A bare screenshot is not actionable: the model can see a control but has no way to name
 * it. Drawing the same `[id]` the accessibility tree uses makes the two views refer to one
 * another, which is what lets a model look at a picture and emit `click elementId=12`.
 *
 * Mirrors browser_use's `_annotated_screenshot`, including resizing back to CSS-viewport
 * resolution — a HiDPI capture is 2× larger for no extra information and costs double the
 * image tokens.
 */
import { detectFaces } from './redact/face-detector'
import type { Bounds, InteractiveElement } from '../shared/types'
import { maskRegions, sensitiveRegions } from './redact/pixels'

/** Distinct enough to tell adjacent boxes apart, dark enough for white label text. */
const PALETTE = [
  '#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00897b',
]

const LABEL_HEIGHT = 14
const FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace'

export interface AnnotateOptions {
  /** Regions layer 2 found in rendered text, which belong to no element. */
  piiRegions?: readonly Bounds[]
  /** Device pixels per CSS pixel in the capture. */
  devicePixelRatio: number
  /** CSS-pixel viewport, used to scale a HiDPI capture back down. */
  viewportWidth: number
  /** Cap on how many boxes to draw; beyond this the image is unreadable anyway. */
  limit?: number
}

/**
 * Returns a PNG data URL of the capture with a labelled box over each element.
 *
 * The capture is in device pixels while element bounds are in CSS pixels, so everything is
 * scaled once here rather than at each draw call.
 */
export interface AnnotatedCapture {
  dataUrl: string
  /** How many regions were painted out. Reported, not assumed. */
  masked: number
}

export async function annotateScreenshot(
  captureDataUrl: string,
  elements: readonly InteractiveElement[],
  options: AnnotateOptions,
): Promise<AnnotatedCapture> {
  const blob = await (await fetch(captureDataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  console.log('[Aegis] Screenshot reached face detector')

  // Draw at CSS-viewport resolution: same information, half the tokens on a Retina panel.
  const scale =
    options.viewportWidth > 0 && bitmap.width > options.viewportWidth
      ? options.viewportWidth / bitmap.width
      : 1
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable.')

  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const detectedFaces = await detectFaces(canvas, width, height)

  // Element bounds are CSS pixels; the drawn image is the capture scaled to CSS width.
  const factor = options.devicePixelRatio * scale

  // Faces were measured on the drawn image, so divide out the conversion the masker is
  // about to apply — otherwise every box is scaled twice on a HiDPI capture.
  const faceRegions: Bounds[] = detectedFaces.map((face) => ({
    x: face.x / factor,
    y: face.y / factor,
    width: face.width / factor,
    height: face.height / factor,
    documentX: face.documentX / factor,
    documentY: face.documentY / factor,
  }))

  const regionsToMask: Bounds[] = [
    ...sensitiveRegions(elements),
    ...(options.piiRegions ?? []),
    ...faceRegions,
  ]

  // Masks go down before labels, in the same pass and the same coordinate space. Before,
  // so a label is never painted out by the mask beside it; the same pass, so there is no
  // second encode and no chance of the two disagreeing about where an element sits.
  const masked = maskRegions(
    ctx,
    regionsToMask,
    factor,
    width,
    height,
  )

  ctx.font = FONT
  ctx.textBaseline = 'top'
  ctx.lineWidth = 1

  const limit = options.limit ?? 80
  let index = 0

  for (const element of elements) {
    if (index >= limit) break

    const { x, y, width: w, height: h } = element.bounds
    const left = Math.round(x * factor)
    const top = Math.round(y * factor)
    const boxWidth = Math.round(w * factor)
    const boxHeight = Math.round(h * factor)

    // Off-screen elements are reported by the scan but have nothing to point at here.
    if (left + boxWidth <= 0 || top + boxHeight <= 0 || left >= width || top >= height) {
      continue
    }

    const colour = PALETTE[index % PALETTE.length]
    index++

    ctx.strokeStyle = colour
    ctx.strokeRect(left + 0.5, top + 0.5, boxWidth, boxHeight)

    const label = String(element.id)
    const labelWidth = Math.ceil(ctx.measureText(label).width) + 6
    // Sit the label above the box, or inside it when there is no room above.
    const labelTop = top >= LABEL_HEIGHT ? top - LABEL_HEIGHT : top

    ctx.fillStyle = colour
    ctx.fillRect(left, labelTop, labelWidth, LABEL_HEIGHT)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, left + 3, labelTop + 2)
  }

  const out = await canvas.convertToBlob({ type: 'image/png' })
  return { dataUrl: `data:image/png;base64,${toBase64(await out.arrayBuffer())}`, masked }
}

/** FileReader is awkward in a worker context; build the base64 directly. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
