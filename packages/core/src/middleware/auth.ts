import type { FastifyPluginAsync } from 'fastify';
import { UnauthorizedError, ForbiddenError } from '@undrecreaitwins/shared';
import { createHash } from 'crypto';
import { db } from '../db.js';
import { apiTokens } from '../models/index.js';
import { eq, and, isNull } from 'drizzle-orm';

export const authPlugin: FastifyPluginAsync = async (fastify) => {
  const authMode = process.env.TWIN_AUTH_MODE || 'standalone';

  if (authMode === 'gateway') {
    return;
  }

  fastify.addHook('onRequest', async (request) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const [found] = await db
      .select({ id: apiTokens.id, tenantId: apiTokens.tenantId })
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)))
      .limit(1);

    if (!found) {
      throw new UnauthorizedError('Invalid or revoked API token');
    }

    if (request.tenantId && request.tenantId !== found.tenantId) {
      throw new ForbiddenError('Token tenant mismatch');
    }

    request.tenantId = found.tenantId;
  });
};
