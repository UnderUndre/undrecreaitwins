import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { resolveKey } from '../lib/auth.js';
import { CohereRerankProvider } from '../providers/cohere-rerank.js';
import { JinaRerankProvider } from '../providers/jina-rerank.js';
import { sanitizeRerankResponse } from '../lib/sanitize.js';
import { BadRequestError, UpstreamError, GatewayTimeoutError } from '../lib/errors.js';
import { getBreaker } from '../lib/circuit-breaker.js';
import { limiter } from '../lib/concurrency.js';

const cohereProvider = new CohereRerankProvider();
const jinaProvider = new JinaRerankProvider();

export const rerankRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/rerank', async (request, reply) => {
    const body = request.body as any;

    if (!body || typeof body !== 'object') {
      throw new BadRequestError('Request body must be a JSON object');
    }

    const { query, documents } = body;

    // Validate query
    if (typeof query !== 'string' || query.trim() === '') {
      throw new BadRequestError('query must be a non-empty string');
    }
    if (query.length > config.MAX_INPUT_CHARS) {
      throw new BadRequestError(`query exceeds MAX_INPUT_CHARS (${config.MAX_INPUT_CHARS})`);
    }

    // Validate documents
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new BadRequestError('documents must be a non-empty array of strings');
    }

    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      if (typeof doc !== 'string' || doc.trim() === '') {
        throw new BadRequestError('documents must be a non-empty array of strings');
      }
      if (doc.length > config.MAX_INPUT_CHARS) {
        throw new BadRequestError(`documents[${i}] exceeds MAX_INPUT_CHARS (${config.MAX_INPUT_CHARS})`);
      }
    }

    const providerName = config.RERANK_PROVIDER;
    const provider = providerName === 'cohere' ? cohereProvider : jinaProvider;
    const model = config.RERANK_MODEL || '';

    // Enforce limits per provider
    if (providerName === 'cohere' && documents.length > 1000) {
      throw new BadRequestError('Cohere provider limits reranking to a maximum of 1000 documents');
    }
    if (providerName === 'jina' && documents.length > 2048) {
      throw new BadRequestError('Jina provider limits reranking to a maximum of 2048 documents');
    }

    // Check circuit breaker
    const breaker = getBreaker(providerName);
    breaker.checkCall();

    // Check concurrency limit
    limiter.acquire();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.UPSTREAM_TIMEOUT_MS);
    if (request.signal) {
      request.signal.addEventListener('abort', () => {
        controller.abort();
      });
    }

    try {
      // Resolve API key
      const apiKey = resolveKey(request, providerName);

      // Call provider
      const rawResult = await provider.rerank(query, documents, model, apiKey, controller.signal);
      clearTimeout(timeoutId);

      // Record success
      breaker.recordSuccess();

      // Sanitize response
      const sanitized = sanitizeRerankResponse(rawResult);
      return reply.send(sanitized);
    } catch (error) {
      clearTimeout(timeoutId);
      // Record failure if it is an upstream/timeout error, but NOT if the client aborted
      if (!request.signal?.aborted && (error instanceof UpstreamError || error instanceof GatewayTimeoutError)) {
        breaker.recordFailure();
      }
      throw error;
    } finally {
      // Release concurrency limit
      limiter.release();
    }
  });
};
