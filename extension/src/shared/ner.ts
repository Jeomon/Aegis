import { pipeline } from '@xenova/transformers';
import type { Match } from './detect';
import type { SensitiveKind } from './types';

let nerPipeline: any = null;

export async function getPipeline() {
  if (!nerPipeline) {
    // Note: In an extension context, model weights will be downloaded to Cache Storage by default.
    nerPipeline = await pipeline('token-classification', 'Xenova/bert-base-NER');
  }
  return nerPipeline;
}

function extractMatches(text: string, tokens: any[]): Match[] {
  const entities: { kind: string, word: string }[] = [];
  let currentWord = '';
  let currentKind = null;
  
  for (const t of tokens) {
    if (t.score < 0.6) continue; // Filter out low-confidence hallucinations

    const isSubword = t.word.startsWith('##');
    const wordPart = isSubword ? t.word.slice(2) : t.word;
    const kind = t.entity === 'O' ? null : t.entity.split('-').pop();
    
    if (kind !== currentKind) {
      if (currentKind) entities.push({ kind: currentKind, word: currentWord });
      currentKind = kind;
      currentWord = wordPart;
    } else if (kind) {
      currentWord += isSubword ? wordPart : ' ' + wordPart;
    }
  }
  if (currentKind) entities.push({ kind: currentKind, word: currentWord });

  const matches: Match[] = [];

  for (const ent of entities) {
    if ((ent.kind === 'PER' || ent.kind === 'LOC' || ent.kind === 'ORG') && ent.word.length > 2) {
      try {
        // Use word boundaries to prevent matching partial words (e.g. 'Aadha' inside 'Aadhaar')
        // and allow flexible whitespace to handle OCR line breaks
        const regexStr = ent.word.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
        const regex = new RegExp(`\\b${regexStr}\\b`, 'g');
        
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            start: match.index,
            end: match.index + match[0].length,
            text: match[0],
            kind: ent.kind as SensitiveKind
          });
        }
      } catch (e) {
        // Regex failed to compile, ignore
      }
    }
  }
  
  return matches;
}

/**
 * Run NER on a batch of strings.
 */
export async function findNerPiiBatch(texts: string[]): Promise<Match[][]> {
  if (texts.length === 0) return [];
  
  const pipe = await getPipeline();
  const results = await pipe(texts, { ignore_labels: [] });
  
  // If the input array has length 1, transformers.js may return just an array of tokens.
  const isArrayOfArrays = Array.isArray(results) && (results.length === 0 || Array.isArray(results[0]));
  const normalizedResults = isArrayOfArrays ? results : [results];

  const batchMatches: Match[][] = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const tokens = normalizedResults[i] || [];
    batchMatches.push(extractMatches(text, tokens));
  }

  return batchMatches;
}
