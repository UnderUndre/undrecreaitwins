/**
 * FR-016: Anti-repeat guard — compares current reply with previous using embeddings.
 * If cosine similarity > threshold AND reruns remaining → regenerate with anti-repeat prompt.
 * Max 1 rerun per call. Still similar after rerun → send with warning.
 * Verbatim fragments MUST be excluded by the caller (always same text by design).
 */

const SIMILARITY_THRESHOLD = 0.85;
const MAX_ANTI_REPEAT_RERUNS = 1;

export interface AntiRepeatResult {
  reply: string;
  rerunTriggered: boolean;
  similarity?: number;
  stillSimilar?: boolean;
}

/**
 * Compute cosine similarity between two embedding vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = a.length;

  for (let i = 0; i < len; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function checkAntiRepeat(params: {
  currentReply: string;
  previousReply: string | undefined;
  embeddingFn: (text: string) => Promise<number[]>;
  regenerateFn: (prompt: string) => Promise<string>;
  remainingReruns: number;
}): Promise<AntiRepeatResult> {
  const { currentReply, previousReply, embeddingFn, regenerateFn, remainingReruns } = params;

  if (!previousReply) {
    return { reply: currentReply, rerunTriggered: false };
  }

  if (remainingReruns <= 0) {
    return { reply: currentReply, rerunTriggered: false };
  }

  const [currentEmb, prevEmb] = await Promise.all([
    embeddingFn(currentReply),
    embeddingFn(previousReply),
  ]);

  const similarity = cosineSimilarity(currentEmb, prevEmb);

  if (similarity <= SIMILARITY_THRESHOLD) {
    return { reply: currentReply, rerunTriggered: false, similarity };
  }

  const rerunsAllowed = Math.min(MAX_ANTI_REPEAT_RERUNS, remainingReruns);
  let reply = currentReply;

  for (let i = 0; i < rerunsAllowed; i++) {
    reply = await regenerateFn('Не повторяй предыдущий ответ. Переформулируй.');
  }

  const [rerunEmb] = await Promise.all([embeddingFn(reply)]);
  const rerunSimilarity = cosineSimilarity(rerunEmb, prevEmb);

  if (rerunSimilarity > SIMILARITY_THRESHOLD) {
    // Still similar after rerun — send with warning
    return { reply, rerunTriggered: true, similarity: rerunSimilarity, stillSimilar: true };
  }

  return { reply, rerunTriggered: true, similarity: rerunSimilarity, stillSimilar: false };
}
