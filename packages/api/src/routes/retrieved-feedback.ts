import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { conversationFeedbackStates } from '@undrecreaitwins/core/models/index.js';
import { internalAuth } from '../middleware/internal-auth.js';

const querySchema = z.object({
  conversationId: z.string().uuid(),
});

export const retrievedFeedbackRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/internal/retrieved-feedback', {
    preHandler: [internalAuth],
  }, async (request, reply) => {
    const parseResult = querySchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.code(400).send({ error: 'Invalid query', details: parseResult.error.issues });
      return;
    }

    const { conversationId } = parseResult.data;
    const tenantId = (request as any).tenantId || request.headers['x-tenant-id'] as string;

    if (!tenantId) {
      reply.code(400).send({ error: 'Missing tenant ID' });
      return;
    }

    try {
      const state = await withTenantContext(tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(conversationFeedbackStates)
          .where(eq(conversationFeedbackStates.conversationId, conversationId));
        return row;
      });

      if (!state) {
        reply.code(404).send({ error: 'Conversation feedback state not found' });
        return;
      }

      reply.send({
        conversationId,
        appliedMemories: (state.appliedFeedbackIds || []).map(id => ({ memoryId: id })),
        messageCount: state.messageCount,
        lastStageLabel: state.lastStageLabel,
      });
    } catch (err) {
      reply.code(500).send({ error: 'Internal error' });
    }
  });
};
