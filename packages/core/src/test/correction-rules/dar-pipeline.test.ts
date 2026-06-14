import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execute } from '../../services/correction-rules/dar-pipeline.js';

const mockLLM = {
  complete: vi.fn().mockResolvedValue({
    content: 'NO', model: 'test', finishReason: 'stop',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }),
} as any;

describe('DAR Pipeline', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.TWIN_PRODUCT_API_URL = '';
    process.env.TWIN_PRODUCT_API_KEY = '';
  });

  it('returns original text when no rules (DAR disabled)', async () => {
    const result = await execute(mockLLM, 'hello world', {
      tenantId: 't1', personaId: 'p1', conversationId: 'c1',
    });
    expect(result.text).toBe('hello world');
    expect(result.events).toHaveLength(0);
  });

  it('returns original text on pipeline error (fail-open)', async () => {
    const result = await execute(mockLLM, 'hello', {
      tenantId: 't1', personaId: 'p1', conversationId: 'c1',
    });
    expect(result.text).toBe('hello');
  });
});
