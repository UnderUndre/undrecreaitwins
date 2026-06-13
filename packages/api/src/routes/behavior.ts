import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PersonaRepository } from '@undrecreaitwins/core/services/persona-repository.js';
import { db } from '@undrecreaitwins/core/db.js';
import { personas } from '@undrecreaitwins/core/models/index.js';
import { eq } from 'drizzle-orm';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { ValidationError } from '@undrecreaitwins/shared';
import type { PacingConfig } from '@undrecreaitwins/core/models/personas.js';

const repo = new PersonaRepository();

const pacingSchema = z.object({
  baseDelayMs: z.number().int().min(0).max(120000),
  typingIndicator: z.boolean(),
  randomVariation: z.boolean(),
});

const behaviorUpdateSchema = z.object({
  ragMode: z.enum(['static', 'tool']).optional(),
  strictRag: z.boolean().optional(),
  strictRagRefusal: z.string().max(500).nullable().optional(),
  ragRelevanceThreshold: z.number().min(0.05).max(0.95).optional(),
  pacing: pacingSchema.optional(),
});

function toBehaviorResponse(row: Record<string, unknown>) {
  const pacing = (row.pacingConfig as PacingConfig) || {
    baseDelayMs: 0,
    typingIndicator: false,
    randomVariation: false,
  };
  return {
    personaId: row.id as string,
    ragMode: row.ragMode as string,
    strictRag: row.strictRag as boolean,
    strictRagRefusal: (row.strictRagRefusal as string | null) ?? null,
    ragRelevanceThreshold: row.ragRelevanceThreshold as number,
    pacing,
  };
}

export const behaviorRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /v1/personas/:id/behavior
   * Returns behavior config (pacing, RAG, strict RAG settings).
   */
  fastify.get('/v1/personas/:id/behavior', async (request) => {
    const { id } = request.params as { id: string };
    const persona = await repo.getById(request.tenantId, id);
    return { data: toBehaviorResponse(persona as Record<string, unknown>) };
  });

  /**
   * PUT /v1/personas/:id/behavior
   * Partial update of behavior settings.
   * Phase 1: ragMode='tool' rejected with 422.
   */
  fastify.put('/v1/personas/:id/behavior', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parseResult = behaviorUpdateSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;

    // Phase 1 gate: reject 'tool' mode
    if (body.ragMode === 'tool') {
      reply.status(422);
      return {
        error: 'rag_mode_not_available',
        message:
          "rag_mode 'tool' is not available in Phase 1. Use 'static' (default).",
      };
    }

    await repo.getById(request.tenantId, id); // verify existence + tenant ownership

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.ragMode !== undefined) updates.ragMode = body.ragMode;
    if (body.strictRag !== undefined) updates.strictRag = body.strictRag;
    if (body.strictRagRefusal !== undefined)
      updates.strictRagRefusal = body.strictRagRefusal;
    if (body.ragRelevanceThreshold !== undefined)
      updates.ragRelevanceThreshold = body.ragRelevanceThreshold;
    if (body.pacing !== undefined) updates.pacingConfig = body.pacing;

    const [updated] = await withTenantContext(request.tenantId, async (tx) =>
      tx
        .update(personas)
        .set(updates)
        .where(eq(personas.id, id))
        .returning(),
    );

    return { data: toBehaviorResponse(updated as Record<string, unknown>) };
  });
};
