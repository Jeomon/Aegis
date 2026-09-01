// The /wasm entry skips JSEP/WebGPU/WebGL glue — we only need CPU inference, and pulling
// the "all backends" bundle makes Vite inline a 27 MB .jsep.wasm we never use.
import * as ort from 'onnxruntime-web/wasm'
import type { Bounds } from '../../shared/types'

const MODEL_PATH = 'models/face_detection_yunet_2023mar.onnx'

/** Fixed in the graph, not a preference: ORT rejects any other input dimension outright. */
const MODEL_INPUT_SIZE = 640

/**
 * YuNet has three detection heads, one per stride, each over its own anchor grid: a
 * 640×640 input gives 80×80 anchors at stride 8, 40×40 at 16 and 20×20 at 32. Small faces
 * are found by the fine grid, large ones by the coarse.
 */
const STRIDES = [8, 16, 32] as const

const CONFIDENCE_THRESHOLD = 0.5

/** Above this overlap two boxes are one face seen by two strides, not two faces. */
const NMS_IOU = 0.3

// ORT ships its WASM binary + JS glue as separate files. In an MV3 extension the default
// CDN fallback is blocked, and side panels have no cross-origin isolation so
// SharedArrayBuffer (and therefore threading) is unavailable — pin both.
ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/')
ort.env.wasm.numThreads = 1

let session: ort.InferenceSession | null = null

export async function loadFaceDetector(): Promise<ort.InferenceSession> {
  if (session) {
    return session
  }

  session = await ort.InferenceSession.create(chrome.runtime.getURL(MODEL_PATH), {
    executionProviders: ['wasm'],
  })

  return session
}

interface Detection {
  bounds: Bounds
  score: number
}

/**
 * Detect faces in a canvas image.
 *
 * Returns boxes in the canvas's own pixel space — the caller knows how that relates to CSS
 * pixels and converts, rather than this module guessing at a scale it was never told.
 */
export async function detectFaces(
  canvas: OffscreenCanvas,
  width: number,
  height: number,
): Promise<Bounds[]> {
  try {
    const session = await loadFaceDetector()

    // Letterbox rather than stretch. A viewport is far wider than it is tall, and squeezing
    // it into a square turns every face into an ellipse the model was never trained on.
    const ratio = Math.min(MODEL_INPUT_SIZE / width, MODEL_INPUT_SIZE / height)

    const modelCanvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE)
    const modelCtx = modelCanvas.getContext('2d')
    if (!modelCtx) return []

    // A fresh canvas is transparent black, so the unused margin reads as (0, 0, 0) padding.
    modelCtx.drawImage(canvas, 0, 0, Math.round(width * ratio), Math.round(height * ratio))
    const imageData = modelCtx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE)

    const outputs = await session.run({ input: preprocessImage(imageData.data) })
    const faces = suppressOverlaps(decodeDetections(outputs, ratio))

    console.log('[Aegis] Detected faces:', faces.length)
    return faces
  } catch (err) {
    console.error('[Aegis] Face detection error:', err)
    return []
  }
}

/**
 * Preprocess image data for YuNet.
 *
 * Planar NCHW in BGR order, and raw 0-255 values: the model was trained on OpenCV's
 * unscaled BGR input, so dividing by 255 here shifts every activation and costs most of
 * the detections rather than merely dimming them.
 */
function preprocessImage(pixels: Uint8ClampedArray): ort.Tensor {
  const plane = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE
  const data = new Float32Array(plane * 3)

  for (let i = 0; i < plane; i++) {
    data[i] = pixels[i * 4 + 2]
    data[plane + i] = pixels[i * 4 + 1]
    data[plane * 2 + i] = pixels[i * 4]
  }

  return new ort.Tensor('float32', data, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE])
}

/**
 * Turn the three heads into boxes, in the coordinates of the image that was handed in.
 *
 * Each anchor carries a classification score, an objectness score, an offset within its
 * cell and a log-space size. Nothing here is a single flat list of rectangles, which is
 * why reading one output tensor as `[x, y, w, h, score]` produces noise.
 */
function decodeDetections(outputs: ort.InferenceSession.OnnxValueMapType, ratio: number): Detection[] {
  const found: Detection[] = []

  for (const stride of STRIDES) {
    const cls = outputs[`cls_${stride}`].data as Float32Array
    const obj = outputs[`obj_${stride}`].data as Float32Array
    const bbox = outputs[`bbox_${stride}`].data as Float32Array
    const cols = MODEL_INPUT_SIZE / stride

    for (let i = 0; i < cls.length; i++) {
      // Two heads, one decision — the geometric mean, as OpenCV's own YuNet post-processing
      // does it: an anchor must both look like a face and hold an object.
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]))
      if (score < CONFIDENCE_THRESHOLD) continue

      const centreX = ((i % cols) + bbox[i * 4]) * stride
      const centreY = (Math.floor(i / cols) + bbox[i * 4 + 1]) * stride
      const boxWidth = Math.exp(bbox[i * 4 + 2]) * stride
      const boxHeight = Math.exp(bbox[i * 4 + 3]) * stride

      // Out of the letterbox, back into the caller's pixels.
      const x = (centreX - boxWidth / 2) / ratio
      const y = (centreY - boxHeight / 2) / ratio

      found.push({
        score,
        // A face belongs to no element and is never scrolled to, so the document
        // coordinates exist only to satisfy the shape the masker consumes.
        bounds: {
          x,
          y,
          width: boxWidth / ratio,
          height: boxHeight / ratio,
          documentX: x,
          documentY: y,
        },
      })
    }
  }

  return found
}

/** Keep the highest-scoring box of each overlapping cluster. */
function suppressOverlaps(detections: Detection[]): Bounds[] {
  const kept: Detection[] = []

  for (const candidate of detections.sort((a, b) => b.score - a.score)) {
    if (kept.some((face) => iou(face.bounds, candidate.bounds) > NMS_IOU)) continue
    kept.push(candidate)
  }

  return kept.map((face) => face.bounds)
}

function iou(a: Bounds, b: Bounds): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)

  const overlap = Math.max(0, right - left) * Math.max(0, bottom - top)
  if (!overlap) return 0

  return overlap / (a.width * a.height + b.width * b.height - overlap)
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
