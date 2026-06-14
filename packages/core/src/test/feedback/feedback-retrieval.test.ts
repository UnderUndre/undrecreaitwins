import { describe, it, expect } from 'vitest';
import { retrieveRelevant } from '../../services/feedback/feedback-retrieval.js';

describe('FeedbackRetrieval', () => {
  it('returns empty when no env config (graceful degradation)', async () => {
    // Without DB + embedding service, retrieval should fail gracefully
    const result = await retrieveRelevant('t1', 'p1', 'hello', { appliedFeedbackIds: [] });
    expect(result.memories).toEqual([]);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns empty array on error (fail-open)', async () => {
    const result = await retrieveRelevant('invalid', 'invalid', '', { appliedFeedbackIds: [] });
    expect(result.memories.length).toBe(0);
  });
});
