import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { invalidate } from '@undrecreaitwins/core/services/correction-rules/rule-cache.js';
import { internalAuth } from '../middleware/internal-auth.js';

const bodySchema = z.object({
  assistantId: z.string().uuid(),
  tenantId: z.string().uuid(),
});

export const correctionRulesReloadRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/internal/rules-reload', {
    preHandler: [internalAuth],
  }, async (request, reply) => {
    const parseResult = bodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.code(400).send({ error: 'Invalid body', details: parseResult.error.issues });
      return;
    }

    const { assistantId } = parseResult.data;
    invalidate(assistantId);
    reply.code(204).send();
  });
};
