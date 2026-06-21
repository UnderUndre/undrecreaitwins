import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from '../src/app.js';
import { fetch } from 'undici';

vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>();
  return {
    ...original,
    fetch: vi.fn(),
  };
});

describe('Performance Benchmarks (Proxy Overhead)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asserts POST /embed overhead is < 50ms', async () => {
    // Mock upstream response resolving immediately
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve({
        status: 200,
        json: async () => ({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: new Array(1024).fill(0.123) }],
        }),
      } as any)
    );

    const start = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: '/embed',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: { inputs: 'perf check text' },
    });
    const duration = performance.now() - start;

    expect(response.statusCode).toBe(200);
    expect(duration).toBeLessThan(50); // Assert < 50ms overhead (SC-003)
  });

  it('asserts POST /rerank overhead is < 50ms', async () => {
    // Mock upstream response resolving immediately
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve({
        status: 200,
        json: async () => ({
          results: [
            { index: 0, relevance_score: 0.99 },
            { index: 1, relevance_score: 0.01 },
          ],
        }),
      } as any)
    );

    const start = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: '/rerank',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: {
        query: 'perf check',
        documents: ['doc 1', 'doc 2'],
      },
    });
    const duration = performance.now() - start;

    expect(response.statusCode).toBe(200);
    expect(duration).toBeLessThan(50); // Assert < 50ms overhead (SC-003)
  });
});
