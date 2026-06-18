export interface PacingOptions {
  /** Reply content to calculate pacing for */
  content: string;
  /** User message sentiment — 'angry' adds +2000ms */
  userSentiment?: string;
  /** Override typing char rate (default 15ms per char) */
  charRateMs?: number;
  /** Override base thinking delay (default 800ms) */
  baseDelayMs?: number;
}

export interface PacingResult {
  /** Recommended delay before sending first chunk, clamped [500, 8000] */
  delay_ms: number;
  /** Text split for typing animation — max 10 chunks, each ≤500 chars */
  typing_chunks: string[];
  /** Directive for channel adapter — whether to simulate typos */
  backspace_simulation: {
    enabled: boolean;
    chance: number;
  };
}

const DEFAULT_CHAR_RATE_MS = 15;
const DEFAULT_BASE_DELAY_MS = 800;
const SENTIMENT_ANGRY_BONUS_MS = 2000;
const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const MAX_CHUNKS = 10;
const MAX_CHUNK_SIZE = 500;

const ANGRY_SENTIMENTS = new Set(['angry', 'frustrated', 'hostile', 'aggressive']);

/**
 * Splits text into grapheme-aware chunks for typing animation.
 * Returns up to MAX_CHUNKS chunks, each ≤ MAX_CHUNK_SIZE chars.
 * Uses Intl.Segmenter when available for proper grapheme handling.
 */
function splitIntoChunks(text: string): string[] {
  if (text.length === 0) return [''];

  const segmenter = typeof Intl !== 'undefined' && (Intl as any).Segmenter
    ? new (Intl as any).Segmenter('en', { granularity: 'grapheme' })
    : null;

  const graphemes: string[] = [];
  if (segmenter) {
    for (const segment of segmenter.segment(text)) {
      graphemes.push(segment.segment);
    }
  } else {
    // Fallback: split by code points (handles surrogate pairs)
    graphemes = [...text];
  }

  if (graphemes.length <= MAX_CHUNK_SIZE) {
    return graphemes.length === 0 ? [''] : [text];
  }

  const chunks: string[] = [];
  let currentChunk = '';
  let chunkCount = 0;

  for (const grapheme of graphemes) {
    if (chunkCount >= MAX_CHUNKS) break;

    if (currentChunk.length + grapheme.length > MAX_CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk);
      chunkCount++;
      currentChunk = grapheme;

      if (chunkCount >= MAX_CHUNKS) break;
    } else {
      currentChunk += grapheme;
    }
  }

  if (currentChunk.length > 0 && chunkCount < MAX_CHUNKS) {
    chunks.push(currentChunk);
  }

  return chunks.length === 0 ? [''] : chunks;
}

/**
 * Calculates pacing metadata for humanized delivery.
 *
 * Formula:
 *   delay_ms = clamp((content.length * char_rate) + base_delay + sentiment_variance, 500, 8000)
 *
 * Bounds:
 *   - delay_ms: clamped [500, 8000]
 *   - typing_chunks: max 10, each ≤ 500 chars, grapheme-aware
 *   - backspace_simulation: directive (adapter decides)
 *
 * Acceptance:
 *   - 200-char reply → ~3800ms
 *   - angry user → +2000ms
 *   - empty reply → 500ms (min)
 *   - 10000-char reply → 8000ms (max)
 */
export function calculatePacing(options: PacingOptions): PacingResult {
  const {
    content,
    userSentiment,
    charRateMs = DEFAULT_CHAR_RATE_MS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
  } = options;

  const isAngry = userSentiment != null && ANGRY_SENTIMENTS.has(userSentiment.toLowerCase());
  const sentimentVariance = isAngry ? SENTIMENT_ANGRY_BONUS_MS : 0;

  const rawDelay = (content.length * charRateMs) + baseDelayMs + sentimentVariance;
  const delay_ms = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(rawDelay)));

  const typing_chunks = splitIntoChunks(content);

  return {
    delay_ms,
    typing_chunks,
    backspace_simulation: {
      enabled: true,
      chance: 0.01,
    },
  };
}
