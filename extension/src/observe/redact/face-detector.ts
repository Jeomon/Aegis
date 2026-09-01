// The /wasm entry skips JSEP/WebGPU/WebGL glue — we only need CPU inference, and pulling
// the "all backends" bundle makes Vite inline a 27 MB .jsep.wasm we never use.
import * as ort from 'onnxruntime-web/wasm'
import type { Bounds } from '../../shared/types'

const MODEL_PATH = 'models/face_detection_yunet_2023mar.onnx'
const MODEL_INPUT_SIZE = 416
const CONFIDENCE_THRESHOLD = 0.5

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

  const modelUrl = chrome.runtime.getURL(MODEL_PATH)

  console.log('[Aegis] Loading YuNet:', modelUrl)

  session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ['wasm'],
  })

  console.log('[Aegis] YuNet loaded')
  console.log('[Aegis] Inputs:', session.inputNames)
  console.log('[Aegis] Outputs:', session.outputNames)

  return session
}

/**
 * Detect faces in a canvas image.
 *
 * Runs YuNet inference on the image and returns bounding boxes for detected faces.
 * Returns normalized coordinates relative to the original image size.
 */
export async function detectFaces(canvas: OffscreenCanvas, width: number, height: number): Promise<Bounds[]> {
  try {
    const session = await loadFaceDetector()
    if (!session) return []

    // Get canvas context and image data
    const ctx = canvas.getContext('2d')
    if (!ctx) return []

    // Create a temporary canvas for model input (MODEL_INPUT_SIZE x MODEL_INPUT_SIZE)
    const modelCanvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE)
    const modelCtx = modelCanvas.getContext('2d')
    if (!modelCtx) return []

    // Draw and resize image to model input size
    modelCtx.drawImage(canvas, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE)
    const imageData = modelCtx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE)

    // Preprocess: convert to tensor and normalize
    const inputTensor = preprocessImage(imageData.data, MODEL_INPUT_SIZE)

    // Run inference
    const feeds = {
      input: inputTensor,
    }

    const outputData = await session.run(feeds)
    const outputKey = session.outputNames[0]
    const rawOutput = outputData[outputKey] as any

    // Parse detections
    const faces = parseDetections(rawOutput, width, height)

    console.log('[Aegis] Detected faces:', faces.length)
    return faces
  } catch (err) {
    console.error('[Aegis] Face detection error:', err)
    return []
  }
}

/**
 * Preprocess image data for YuNet model.
 *
 * Converts RGBA to BGR and normalizes to [0, 1].
 */
function preprocessImage(imageData: Uint8ClampedArray, size: number): ort.Tensor {
  // Create float32 array for model input (BGR format, normalized)
  const float32Data = new Float32Array(size * size * 3)

  for (let i = 0; i < size * size; i++) {
    // RGBA -> BGR with normalization
    const r = imageData[i * 4] / 255.0
    const g = imageData[i * 4 + 1] / 255.0
    const b = imageData[i * 4 + 2] / 255.0

    // BGR order
    float32Data[i * 3] = b
    float32Data[i * 3 + 1] = g
    float32Data[i * 3 + 2] = r
  }

  return new ort.Tensor('float32', float32Data, [1, 3, size, size])
}

/**
 * Parse YuNet model output into face bounding boxes.
 *
 * YuNet outputs: [x, y, w, h, confidence, ...]
 * Map back to original image coordinates.
 */
function parseDetections(output: any, originalWidth: number, originalHeight: number): Bounds[] {
  const faces: Bounds[] = []

  try {
    const rawOutput = output
    const data = output?.data ?? output

    console.log('[Aegis] Raw YuNet output:', rawOutput)
    console.log('[Aegis] Parsed data:', data)
    console.log('[Aegis] Output type:', typeof data, 'length:', data?.length)

    if (!data || data.length === 0) {
      console.log('[Aegis] No data returned from YuNet')
      return []
    }

    const scale_x = originalWidth / MODEL_INPUT_SIZE
    const scale_y = originalHeight / MODEL_INPUT_SIZE

    console.log('[Aegis] Data length:', data.length)
    console.log('[Aegis] First 20 values:', Array.from(data.slice(0, 20)))

    for (let i = 0; i < data.length; i += 6) {
      const confidence = data[i + 4]
      console.log(`[Aegis] Checking block at index ${i}: confidence=${confidence}`)

      if (confidence < CONFIDENCE_THRESHOLD) continue

      const x = data[i] * scale_x
      const y = data[i + 1] * scale_y
      const w = data[i + 2] * scale_x
      const h = data[i + 3] * scale_y

      console.log('[Aegis] Face candidate found:', { x, y, w, h, confidence })

      faces.push({
        x: Math.max(0, x),
        y: Math.max(0, y),
        width: Math.max(0, w),
        height: Math.max(0, h),
        documentX: Math.max(0, x),
        documentY: Math.max(0, y),
      })
    }

    console.log('[Aegis] Final face count:', faces.length)
  } catch (err) {
    console.error('[Aegis] Error parsing detections:', err)
  }

  return faces
}