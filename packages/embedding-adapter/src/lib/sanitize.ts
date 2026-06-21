import { z } from 'zod';
import { UpstreamError } from './errors.js';
import type { RerankResult } from '../types.js';

const SingleVectorSchema = z.array(z.number());
const BatchVectorSchema = z.array(z.array(z.number()));

export function sanitizeEmbedResponse(response: unknown): number[] | number[][] {
  const singleResult = SingleVectorSchema.safeParse(response);
  if (singleResult.success) {
    return singleResult.data;
  }

  const batchResult = BatchVectorSchema.safeParse(response);
  if (batchResult.success) {
    return batchResult.data;
  }

  throw new UpstreamError('Upstream response validation failed: invalid vector structure');
}

const RerankResultSchema = z.object({
  index: z.number().int().nonnegative(),
  score: z.number(),
});
const RerankResponseSchema = z.array(RerankResultSchema);

export function sanitizeRerankResponse(response: unknown): RerankResult[] {
  const result = RerankResponseSchema.safeParse(response);
  if (!result.success) {
    throw new UpstreamError('Upstream rerank response validation failed: invalid rerank results structure');
  }
  return result.data;
}
