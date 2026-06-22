import { describe, it, expect, vi, beforeEach } from 'vitest';
import { app } from '../src/app.js';
import { fetch } from 'undici';
import { resetBreakers } from '../src/lib/circuit-breaker.js';

// Mock undici fetch
vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>();
  return {
    ...original,
    fetch: vi.fn(),
  };
});

describe('Embedding Adapter Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBreakers();
  });

  // T035: GET /health
  it('GET /health returns liveness status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe('ok');
    expect(json.provider).toBeDefined();
  });

  // T034: Missing credentials
  it('rejects requests with 401 if no credentials provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/embed',
      body: { inputs: 'test' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('UNAUTHORIZED');
  });

  // T028: POST /embed single input
  it('POST /embed returns single vector for single input', async () => {
    const mockEmbedResponse = {
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      json: async () => mockEmbedResponse,
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/embed',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: { inputs: 'hello world' },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json).toEqual([[0.1, 0.2, 0.3]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // T029: POST /embed batch input
  it('POST /embed returns array of vectors for batch input', async () => {
    const mockEmbedResponse = {
      object: 'list',
      data: [
        { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
        { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
      ],
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      json: async () => mockEmbedResponse,
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/embed',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: { inputs: ['hello', 'world'] },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  // T030: POST /rerank
  it('POST /rerank returns sorted rerank results', async () => {
    const mockRerankResponse = {
      results: [
        { index: 1, relevance_score: 0.95 },
        { index: 0, relevance_score: 0.12 },
      ],
    };

    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      json: async () => mockRerankResponse,
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/rerank',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: {
        query: 'test query',
        documents: ['doc A', 'doc B'],
      },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json).toEqual([
      { index: 1, score: 0.95 },
      { index: 0, score: 0.12 },
    ]);
  });

  // T031: Auth header resolution -> key forwarding
  it('extracts and forwards authorization key from headers', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.9] }],
      }),
    } as any);

    await app.inject({
      method: 'POST',
      url: '/embed',
      headers: {
        authorization: 'Bearer custom_forwarded_key',
      },
      body: { inputs: 'test' },
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer custom_forwarded_key',
        }),
      })
    );
  });

  it('forwards request to custom OPENAI_BASE_URL when configured', async () => {
    const { config: testConfig } = await import('../src/config.js');
    const originalBaseUrl = testConfig.OPENAI_BASE_URL;
    testConfig.OPENAI_BASE_URL = 'https://custom-openai-provider.internal/v1';

    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [[0.99]] }],
      }),
    } as any);

    const originalProvider = testConfig.EMBEDDING_PROVIDER;
    testConfig.EMBEDDING_PROVIDER = 'openai';

    await app.inject({
      method: 'POST',
      url: '/embed',
      headers: {
        authorization: 'Bearer mock_key',
      },
      body: { inputs: 'test' },
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://custom-openai-provider.internal/v1/embeddings',
      expect.any(Object)
    );

    testConfig.OPENAI_BASE_URL = originalBaseUrl;
    testConfig.EMBEDDING_PROVIDER = originalProvider;
  });

  // T032: Empty input rejection
  it('rejects empty input in /embed with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/embed',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: { inputs: '' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('BAD_REQUEST');
  });

  // T033: Upstream timeout
  it('returns 504 on upstream timeout', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));

    const response = await app.inject({
      method: 'POST',
      url: '/embed',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: { inputs: 'test' },
    });

    expect(response.statusCode).toBe(504);
    expect(response.json().error).toBe('GATEWAY_TIMEOUT');
  });

  // T043: Integration test for /rerank — verify top_n: documents.length passed
  it('verifies that top_n equal to documents.length is passed to the upstream provider', async () => {
    const docs = new Array(50).fill('doc');
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        results: docs.map((_, i) => ({ index: i, relevance_score: 0.9 })),
      }),
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/rerank',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: {
        query: 'test',
        documents: docs,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"top_n":50'),
      })
    );
  });

  // T044: Integration test for MAX_INPUT_CHARS rejection
  it('rejects query exceeding MAX_INPUT_CHARS with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/rerank',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: {
        query: 'a'.repeat(9000), // exceeds MAX_INPUT_CHARS (8192)
        documents: ['doc'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('BAD_REQUEST');
    expect(response.json().message).toContain('exceeds MAX_INPUT_CHARS');
  });

  // T045: Integration test for circuit breaker open -> 503, half-open recovery
  it('opens circuit after failure threshold is reached and recovers on success', async () => {
    // Make threshold failures
    for (let i = 0; i < 5; i++) {
      vi.mocked(fetch).mockResolvedValueOnce({
        status: 500,
        text: async () => 'Upstream Error',
      } as any);

      await app.inject({
        method: 'POST',
        url: '/embed',
        headers: {
          authorization: 'Bearer jina_mock_key',
        },
        body: { inputs: 'test' },
      });
    }

    // Next request should fail with 503 immediately without calling fetch
    const response503 = await app.inject({
      method: 'POST',
      url: '/embed',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: { inputs: 'test' },
    });

    expect(response503.statusCode).toBe(503);
    expect(response503.json().error).toBe('CIRCUIT_OPEN');

    // Restore or modify circuit state via time mock
    const originalNow = Date.now;
    Date.now = () => originalNow() + 35 * 1000; // Fast-forward 35 seconds

    // Next request should be HALF_OPEN and make a call
    vi.mocked(fetch).mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
      }),
    } as any);

    const responseRecover = await app.inject({
      method: 'POST',
      url: '/embed',
      headers: {
        authorization: 'Bearer jina_mock_key',
      },
      body: { inputs: 'test' },
    });

    expect(responseRecover.statusCode).toBe(200);

    // Restore Date.now
    Date.now = originalNow;
  });
});
