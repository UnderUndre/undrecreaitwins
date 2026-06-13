import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { llmRetryJobs } from '@undrecreaitwins/core/models/index.js';
import { eq, and, desc } from 'drizzle-orm';

const querySchema = z.object({
  status: z.enum(['pending', 'in_progress', 'completed', 'dlq']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Retry jobs API — DLQ visibility (017-hybrid-agent-core, task 1.8).
 *
 * GET /v1/retry-jobs?status=dlq&limit=50&offset=0
 * Returns tenant-scoped list of retry jobs with current status.
 */
export const retryJobsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/retry-jobs', async (request) => {
    const parseResult = querySchema.safeParse(request.query);
    if (!parseResult.success) {
      return {
        data: [],
        error: 'Invalid query parameters',
        details: parseResult.error.issues,
      };
    }
    const { status, limit, offset } = parseResult.data;

    const rows = await withTenantContext(request.tenantId, async (tx) => {
      const conditions = [eq(llmRetryJobs.tenantId, request.tenantId)];
      if (status) {
        conditions.push(eq(llmRetryJobs.status, status));
      }

      return tx
        .select({
          id: llmRetryJobs.id,
          personaId: llmRetryJobs.personaId,
          conversationId: llmRetryJobs.conversationId,
          channelMessageId: llmRetryJobs.channelMessageId,
          attemptCount: llmRetryJobs.attemptCount,
          maxAttempts: llmRetryJobs.maxAttempts,
          status: llmRetryJobs.status,
          nextRetryAt: llmRetryJobs.nextRetryAt,
          createdAt: llmRetryJobs.createdAt,
          updatedAt: llmRetryJobs.updatedAt,
        })
        .from(llmRetryJobs)
        .where(and(...conditions))
        .orderBy(desc(llmRetryJobs.createdAt))
        .limit(limit)
        .offset(offset);
    });

    return { data: rows };
  });
};
