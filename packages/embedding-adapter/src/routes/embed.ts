import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { resolveKey } from '../lib/auth.js';
import { JinaEmbedProvider } from '../providers/jina-embed.js';
import { OpenAIEmbedProvider } from '../providers/openai-embed.js';
import { sanitizeEmbedResponse } from '../lib/sanitize.js';
import { BadRequestError, UpstreamError, GatewayTimeoutError } from '../lib/errors.js';
import { getBreaker } from '../lib/circuit-breaker.js';
import { limiter } from '../lib/concurrency.js';

const jinaProvider = new JinaEmbedProvider();
const openaiProvider = new OpenAIEmbedProvider();

export const embedRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/embed', async (request, reply) => {
    const body = request.body as any;

    if (!body || typeof body !== 'object') {
      throw new BadRequestError('Request body must be a JSON object');
    }

    const { inputs } = body;

    // Validate inputs (including empty/null inputs and MAX_INPUT_CHARS)
    if (inputs === undefined || inputs === null) {
      throw new BadRequestError('inputs must be a non-empty string or array');
    }

    if (typeof inputs === 'string') {
      if (inputs.trim() === '') {
        throw new BadRequestError('inputs must be a non-empty string or array');
      }
      if (inputs.length > config.MAX_INPUT_CHARS) {
        throw new BadRequestError(`inputs exceeds MAX_INPUT_CHARS (${config.MAX_INPUT_CHARS})`);
      }
    } else if (Array.isArray(inputs)) {
      if (inputs.length === 0) {
        throw new BadRequestError('inputs must be a non-empty string or array');
      }
      for (let i = 0; i < inputs.length; i++) {
        const item = inputs[i];
        if (typeof item !== 'string' || item.trim() === '') {
          throw new BadRequestError('inputs must be a non-empty string or array');
        }
        if (item.length > config.MAX_INPUT_CHARS) {
          throw new BadRequestError(`inputs[${i}] exceeds MAX_INPUT_CHARS (${config.MAX_INPUT_CHARS})`);
        }
      }
    } else {
      throw new BadRequestError('inputs must be a non-empty string or array');
    }

    const providerName = config.EMBEDDING_PROVIDER;
    const provider = providerName === 'openai' ? openaiProvider : jinaProvider;
    const model = config.EMBEDDING_MODEL || '';

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
      const rawResult = await provider.embed(inputs, model, apiKey, controller.signal);
      clearTimeout(timeoutId);

      // Record success
      breaker.recordSuccess();

      // Sanitize response
      const sanitized = sanitizeEmbedResponse(rawResult);
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
