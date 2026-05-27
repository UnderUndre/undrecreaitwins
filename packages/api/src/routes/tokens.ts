import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomBytes, createHash } from 'crypto';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { apiTokens } from '@undrecreaitwins/core/models/index.js';
import { eq, and, isNull } from 'drizzle-orm';
import { NotFoundError, ValidationError } from '@undrecreaitwins/shared';

const createTokenSchema = z.object({
  name: z.string().min(1).max(200),
});

export const tokenRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/tokens', async (request, reply) => {
    const parseResult = createTokenSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const [created] = await withTenantContext(request.tenantId, async (tx) => {
      return tx
        .insert(apiTokens)
        .values({
          tenantId: request.tenantId,
          name: body.name,
          tokenHash,
        })
        .returning({
          id: apiTokens.id,
          tenantId: apiTokens.tenantId,
          name: apiTokens.name,
          createdAt: apiTokens.createdAt,
        });
    });

    reply.status(201);
    return {
      ...created,
      token,
    };
  });

  fastify.delete('/v1/tokens/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    await withTenantContext(request.tenantId, async (tx) => {
      const [revoked] = await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiTokens.id, id),
            eq(apiTokens.tenantId, request.tenantId),
            isNull(apiTokens.revokedAt),
          ),
        )
        .returning({ id: apiTokens.id });

      if (!revoked) {
        throw new NotFoundError('API token', id);
      }
    });

    reply.status(204);
  });
};
