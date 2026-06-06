import { FastifyPluginCallback } from 'fastify';
import { ApiKeyService } from '@undrecreaitwins/core/services/api-key.service.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(keyId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(keyId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(keyId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  entry.count++;
  return entry.count <= RATE_LIMIT_MAX_REQUESTS;
}

export const authPublicPlugin: FastifyPluginCallback = (fastify, _opts, done) => {
  fastify.addHook('onRequest', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: { message: 'Missing or invalid Authorization header', type: 'invalid_request_error', code: 'invalid_api_key' },
      });
    }

    const plaintextKey = authHeader.slice(7);
    const meta = await ApiKeyService.validateKey(plaintextKey);

    if (!meta) {
      return reply.status(401).send({
        error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' },
      });
    }

    if (!checkRateLimit(meta.id)) {
      return reply.status(429).send({
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
      });
    }

    request.tenantId = meta.workspaceId;
    request.apiKeyMeta = {
      keyId: meta.id,
      mode: meta.mode,
      workspaceId: meta.workspaceId,
    };

    await ApiKeyService.touchLastUsed(meta.id);
  });

  done();
};
