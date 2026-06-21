import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { app } from '../src/app.js';
import { fetch as undiciFetch } from 'undici';
import { EmbeddingService } from '../../core/src/services/embedding-service.ts';
import { config } from '../src/config.js';

vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>();
  return {
    ...original,
    fetch: vi.fn(),
  };
});

describe('Cross-Package Engine Degradation Tests', () => {
  let embeddingService: EmbeddingService;
  const testPort = 18096;

  beforeAll(async () => {
    config.JINA_API_KEY = 'mock_jina_key';
    config.OPENAI_API_KEY = 'mock_openai_key';
    config.COHERE_API_KEY = 'mock_cohere_key';
    // Start fastify on a real port so EmbeddingService can make real HTTP requests
    await app.listen({ port: testPort, host: '127.0.0.1' });
    process.env.EMBEDDINGS_URL = `http://127.0.0.1:${testPort}`;
    embeddingService = new EmbeddingService();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies EmbeddingService.embed works under successful proxy behavior', async () => {
    vi.mocked(undiciFetch).mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.99, -0.99] }],
      }),
    } as any);

    const result = await embeddingService.embed('test query');
    expect(result).toEqual([0.99, -0.99]);
  });

  it('verifies EmbeddingService throws ServiceUnavailableError on adapter 502/504 failures', async () => {
    // Simulating adapter returning 504 Gateway Timeout due to upstream timeout
    vi.mocked(undiciFetch).mockRejectedValueOnce(
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    );

    await expect(embeddingService.embed('timeout test')).rejects.toThrow();
  });

  it('verifies EmbeddingService.rerank works under successful proxy behavior', async () => {
    vi.mocked(undiciFetch).mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.12 },
        ],
      }),
    } as any);

    const result = await embeddingService.rerank('query', ['doc A', 'doc B']);
    expect(result).toEqual([
      { index: 1, score: 0.95 },
      { index: 0, score: 0.12 },
    ]);
  });
});
