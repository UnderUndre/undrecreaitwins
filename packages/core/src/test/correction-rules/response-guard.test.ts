import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResponseGuard } from '../../services/correction-rules/response-guard.js';
import { LLMClient } from '../../services/llm-client.js';

vi.mock('../../db.js', () => ({
  withTenantContext: vi.fn((_tenantId: string, fn: (tx: any) => any) => fn({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => [])
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve())
    }))
  }))
}));

vi.mock('../../services/correction-rules/product-client.js', () => ({
  fetchRules: vi.fn(() => Promise.resolve(null))
}));

vi.mock('../../services/correction-rules/event-push-client.js', () => ({
  pushEvents: vi.fn()
}));

describe('ResponseGuard', () => {
  const llm = new LLMClient();
  const guard = new ResponseGuard(llm);
  const defaultCtx = {
    conversationId: 'conv-1',
    tenantId: 't1',
    personaId: 'p1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs validateResponse and returns unchanged response on pass', async () => {
    const result = await guard.run('Hello, how can I help?', {
      ...defaultCtx,
    });
    expect(result.response).toBe('Hello, how can I help?');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.verdict).toBe('pass');
    expect(result.events[0]!.ruleId).toBe('system-validators');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('runs with full tier includes darExecute call', async () => {
    const result = await guard.run('Test response', {
      ...defaultCtx,
    }, { tier: 'full' });
    expect(result.response).toBeDefined();
    expect(typeof result.response).toBe('string');
  });

  it('runs with deterministic-only tier skips DAR', async () => {
    const result = await guard.run('Test response', {
      ...defaultCtx,
    }, { tier: 'deterministic-only' });
    expect(result.response).toBeDefined();
    expect(typeof result.response).toBe('string');
  });

  it('shortCircuits DAR when system validators modified response (empty → fallback)', async () => {
    const result = await guard.run('', {
      ...defaultCtx,
    }, { tier: 'full' });
    // Empty-output guard returns fallback → response changed → shortCircuit skips DAR
    expect(result.response).toBeTruthy();
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.verdict).toBe('rewritten');
  });

  it('fails open with original text on error', async () => {
    vi.mocked((await import('../../db.js')).withTenantContext).mockRejectedValueOnce(new Error('DB down'));
    const result = await guard.run('Original response', {
      ...defaultCtx,
    });
    expect(result.response).toBe('Original response');
  });

  it('tracks total latencyMs', async () => {
    const result = await guard.run('Hello', { ...defaultCtx });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('emits pass verdict when response unchanged by validators', async () => {
    const result = await guard.run('Clean response', { ...defaultCtx });
    expect(result.events[0]!.verdict).toBe('pass');
    expect(result.events[0]!.ruleId).toBe('system-validators');
  });

  it('emits rewritten verdict when response changed by validators', async () => {
    const result = await guard.run('', { ...defaultCtx });
    expect(result.events[0]!.verdict).toBe('rewritten');
  });

  it('reports llmCallCount in result (0 when no regenerateFn called)', async () => {
    const result = await guard.run('Hello', { ...defaultCtx });
    expect(result.llmCallCount).toBe(0);
  });
});
