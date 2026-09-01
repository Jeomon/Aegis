import { createWorker } from 'tesseract.js'
import { findPii, redactText } from '../shared/detect'
import { findNerPiiBatch } from '../shared/ner'
import { conceal } from './vault'
import type { Bounds } from '../shared/types'

let workerPromise: Promise<Tesseract.Worker> | null = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // Initialize the tesseract worker
      const worker = await createWorker('eng');
      return worker;
    })()
  }
  return workerPromise;
}

export interface OcrResult {
  regions: Bounds[]
  text: string
}

export async function scanImagesForPii(): Promise<OcrResult> {
  const rawImages = Array.from(document.querySelectorAll('img'));

  const images = rawImages.filter(img => {
    const rect = img.getBoundingClientRect();
    return rect.width > 50 && rect.height > 50; // Skip tiny icons
  });

  if (images.length === 0) {
    return { regions: [], text: '' };
  }

  let worker;
  try {
    worker = await getWorker();
  } catch (e) {
    console.warn("Failed to initialize Tesseract worker:", e);
    return { regions: [], text: '' };
  }

  const allRegions: Bounds[] = [];
  const allText: string[] = [];

  for (const img of images) {
    try {
      const rect = img.getBoundingClientRect();
      const canvas = document.createElement('canvas');
      
      canvas.width = img.naturalWidth || rect.width;
      canvas.height = img.naturalHeight || rect.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      let dataUrl: string;
      try {
        dataUrl = canvas.toDataURL('image/jpeg');
      } catch (e) {
        console.warn("Canvas tainted by CORS:", e);
        continue;
      }
      
      const { data } = await worker.recognize(dataUrl, {}, { text: true, blocks: true });
      
      if (data.blocks) {
        for (const block of data.blocks) {
          for (const paragraph of (block.paragraphs || [])) {
            for (const line of (paragraph.lines || [])) {
              const text = line.text.trim();
              if (text.length < 5) continue; // skip very short OCR artifacts

              const matches = findPii(text);
              if (matches.length > 0) {
                const scaleX = rect.width / img.naturalWidth;
                const scaleY = rect.height / img.naturalHeight;

                for (const word of (line.words || [])) {
                  const wordMatches = findPii(word.text);
                  if (wordMatches.length > 0) {
                    const bbox = word.bbox;
                    const scaledX = rect.left + window.scrollX + (bbox.x0 * scaleX);
                    const scaledY = rect.top + window.scrollY + (bbox.y0 * scaleY);
                    const scaledWidth = (bbox.x1 - bbox.x0) * scaleX;
                    const scaledHeight = (bbox.y1 - bbox.y0) * scaleY;

                    allRegions.push({
                      x: scaledX - window.scrollX,
                      y: scaledY - window.scrollY,
                      width: scaledWidth,
                      height: scaledHeight,
                      documentX: scaledX,
                      documentY: scaledY
                    });
                  }
                }
              }
            }
          }
        }
      }
      
      // Redact the full text
      const rawText = data.text.trim();
      if (rawText.length > 0) {
        const nerMatches = await findNerPiiBatch([rawText]);
        const { text: redacted } = redactText(rawText, conceal, nerMatches[0]);
        allText.push(`[Image OCR]: ${redacted}`);
      }
    } catch (e) {
      console.warn("OCR completely failed for image:", e);
    }
  }

  return {
    regions: allRegions,
    text: allText.join('\n')
  }
}
