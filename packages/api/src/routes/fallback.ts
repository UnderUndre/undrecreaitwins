import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PersonaRepository } from '@undrecreaitwins/core/services/persona-repository.js';
import { db } from '@undrecreaitwins/core/db.js';
import { personas } from '@undrecreaitwins/core/models/index.js';
import { eq } from 'drizzle-orm';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { ValidationError } from '@undrecreaitwins/shared';

const repo = new PersonaRepository();

const fallbackUpdateSchema = z.object({
  fallbackMessages: z.array(z.string().min(1).max(500)).min(0).max(20),
  fallbackThresholdMs: z.number().int().min(3000).max(55000).optional(),
});

function toFallbackResponse(row: Record<string, unknown>) {
  return {
    personaId: row.id as string,
    fallbackMessages: (row.fallbackMessages as string[]) || [],
    fallbackThresholdMs: row.fallbackThresholdMs as number,
  };
}

export const fallbackRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /v1/personas/:id/fallback
   * Returns fallback config for a persona.
   */
  fastify.get('/v1/personas/:id/fallback', async (request) => {
    const { id } = request.params as { id: string };
    const persona = await repo.getById(request.tenantId, id);
    return { data: toFallbackResponse(persona as Record<string, unknown>) };
  });

  /**
   * PUT /v1/personas/:id/fallback
   * Replaces fallback config. Validates threshold range and message pool size.
   */
  fastify.put('/v1/personas/:id/fallback', async (request) => {
    const { id } = request.params as { id: string };
    const parseResult = fallbackUpdateSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;

    await repo.getById(request.tenantId, id); // verify existence + tenant ownership

    const [updated] = await withTenantContext(request.tenantId, async (tx) =>
      tx
        .update(personas)
        .set({
          fallbackMessages: body.fallbackMessages,
          ...(body.fallbackThresholdMs !== undefined && {
            fallbackThresholdMs: body.fallbackThresholdMs,
          }),
          updatedAt: new Date(),
        })
        .where(eq(personas.id, id))
        .returning(),
    );

    return { data: toFallbackResponse(updated as Record<string, unknown>) };
  });
};
