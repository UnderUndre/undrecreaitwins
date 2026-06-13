import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { FunnelRepository } from '@undrecreaitwins/core/services/funnel/funnel-repository.js';
import { db } from '@undrecreaitwins/core/db.js';
import { personas } from '@undrecreaitwins/core/models/index.js';
import { eq as eqOp, and } from 'drizzle-orm';
import { ValidationError } from '@undrecreaitwins/shared';

const repo = new FunnelRepository();

async function getPersonaFunnelGeneration(tenantId: string, personaId: string): Promise<string> {
  const row = await db.select({ funnelGeneration: personas.funnelGeneration })
    .from(personas)
    .where(and(eqOp(personas.id, personaId), eqOp(personas.tenantId, tenantId)))
    .limit(1);
  return row[0]?.funnelGeneration ?? 'single';
}

const resolutionCriteriaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fragment_selected'), fragment_id: z.string().uuid() }),
  z.object({ type: z.literal('slot_filled'), slot_name: z.string() }),
  z.object({ type: z.literal('all_slots_filled') }),
]);

const createVersionSchema = z.object({
  config: z.object({
    relevance_threshold: z.number().min(0).max(100),
    off_script_behavior: z.enum(['steer', 'abstain', 'catch_all']),
    catch_all_fragment_id: z.string().uuid().optional(),
    stuck_threshold: z.number().int().min(1),
    stuck_action: z.enum(['yield_generation', 'handoff', 'exit_stage']),
    scoring_weights: z.object({
      exact_match: z.number(),
      stemmed_match: z.number(),
      synonym_match: z.number(),
      stage_boost: z.number(),
      next_stage_bonus: z.number(),
      objection_boost: z.number(),
    }),
  }),
  stages: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    order: z.number().int(),
    objective: z.string().optional(),
    resolutionCriteria: resolutionCriteriaSchema,
    nextStageId: z.string().uuid().optional(),
    stuckAction: z.enum(['yield_generation', 'handoff', 'exit_stage']).optional(),
    exitStageId: z.string().uuid().optional(),
    fragments: z.array(z.object({
      type: z.enum(['normal', 'objection']),
      content: z.string().min(1),
      triggers: z.object({
        phrases: z.array(z.string()).optional(),
        synonyms: z.record(z.array(z.string())).optional(),
      }),
      scoreWeight: z.number().default(1.0),
    })),
  })).min(1),
  slots: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    stageId: z.string().uuid().optional(),
    validationRules: z.record(z.unknown()).optional(),
  })).default([]),
});

export const funnelRoutes: FastifyPluginAsync = async (fastify) => {
  // ─── GET /v1/personas/:id/funnel ───
  // Returns the active funnel version for a persona, including stages, slots, config,
  // and the persona's funnelGeneration mode (single/dual).
  fastify.get('/v1/personas/:id/funnel', async (request, reply) => {
    const { id: personaId } = request.params as { id: string };
    const tenantId = request.tenantId;

    const funnel = await repo.getActiveVersion(tenantId, personaId);

    if (!funnel) {
      reply.status(404);
      return { error: 'No active funnel for this persona' };
    }

    // Extract funnelGeneration from persona definition (stored on the definition)
    // The definition is attached via getActiveVersion → definition relation
    const funnelGeneration = (funnel as any).definition?.funnelGeneration
      ?? (await getPersonaFunnelGeneration(tenantId, personaId))
      ?? 'single';

    return {
      id: (funnel as any).definition?.id,
      name: (funnel as any).definition?.name,
      funnelGeneration,
      config: (funnel as any).config,
      stages: ((funnel as any).stages ?? []).map((s: any) => ({
        id: s.id,
        name: s.name,
        order: s.order,
        objective: s.objective ?? null,
        resolutionCriteria: s.resolutionCriteria,
        nextStageId: s.nextStageId ?? null,
        stuckAction: s.stuckAction ?? null,
        exitStageId: s.exitStageId ?? null,
        fragments: (s.fragments ?? []).map((f: any) => ({
          id: f.id,
          type: f.type,
          content: f.content,
          triggers: f.triggers,
          scoreWeight: f.scoreWeight ?? 1.0,
        })),
      })),
      slots: ((funnel as any).slots ?? []).map((sl: any) => ({
        id: sl.id,
        name: sl.name,
        description: sl.description ?? null,
        stageId: sl.stageId ?? null,
        validationRules: sl.validationRules ?? null,
      })),
      versionNumber: (funnel as any).versionNumber,
      createdAt: (funnel as any).createdAt,
    };
  });

  // ─── PUT /v1/personas/:id/funnel ───
  // Updates funnel config + stages by creating a new version.
  // Optionally updates funnelGeneration on the persona.
  fastify.put('/v1/personas/:id/funnel', async (request, _reply) => {
    const { id: personaId } = request.params as { id: string };
    const tenantId = request.tenantId;

    const bodySchema = z.object({
      name: z.string().min(1).optional(),
      funnelGeneration: z.enum(['single', 'dual']).optional(),
      config: createVersionSchema.shape.config.optional(),
      stages: createVersionSchema.shape.stages.optional(),
      slots: createVersionSchema.shape.slots.optional(),
    });

    const body = bodySchema.parse(request.body);

    // Find or create funnel definition for this persona
    let funnel = await repo.getActiveVersion(tenantId, personaId);
    let definitionId: string;

    if (!funnel) {
      // No funnel exists — create one
      const def = await repo.createFunnel(tenantId, personaId, body.name ?? 'Default Funnel');
      definitionId = def.id;
    } else {
      definitionId = (funnel as any).definition?.id;
    }

    // Create new version if stages/config provided
    if (body.config && body.stages) {
      // Validate
      if (body.config.off_script_behavior === 'catch_all' && !body.config.catch_all_fragment_id) {
        throw new ValidationError([{ field: 'config.catch_all_fragment_id', message: 'Required when behavior is catch_all' }]);
      }

      for (const [index, stage] of body.stages.entries()) {
        if (stage.fragments.length === 0) {
          throw new ValidationError([{ field: `stages[${index}].fragments`, message: 'Stage must have at least one fragment (FR-026)' }]);
        }
        const effectiveStuckAction = stage.stuckAction || body.config.stuck_action;
        if (effectiveStuckAction === 'exit_stage' && !stage.exitStageId) {
          throw new ValidationError([{ field: `stages[${index}].exitStageId`, message: 'Required when stuck action is exit_stage' }]);
        }
      }

      await repo.createVersion(
        definitionId,
        body.config as any,
        body.stages as any,
        (body.slots ?? []) as any,
      );
    }

    // Update funnelGeneration on persona if provided
    if (body.funnelGeneration) {
      await db.update(personas)
        .set({ funnelGeneration: body.funnelGeneration })
        .where(and(eqOp(personas.id, personaId), eqOp(personas.tenantId, tenantId)));
    }

    // Return updated funnel
    const updated = await repo.getActiveVersion(tenantId, personaId);
    return {
      id: definitionId,
      funnelGeneration: body.funnelGeneration ?? 'single',
      versionNumber: (updated as any)?.versionNumber,
      updated: true,
    };
  });

  fastify.post('/v1/funnels', async (request, reply) => {
    const schema = z.object({
      persona_id: z.string().uuid(),
      name: z.string().min(1),
    });
    const body = schema.parse(request.body);
    const funnel = await repo.createFunnel(request.tenantId, body.persona_id, body.name);
    reply.status(201);
    return funnel;
  });

  fastify.post('/v1/funnels/:id/versions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = createVersionSchema.parse(request.body);
    
    // Additional validation logic (FR-017, FR-026)
    if (body.config.off_script_behavior === 'catch_all' && !body.config.catch_all_fragment_id) {
        throw new ValidationError([{ field: 'config.catch_all_fragment_id', message: 'Required when behavior is catch_all' }]);
    }

    for (const [index, stage] of body.stages.entries()) {
        if (stage.fragments.length === 0) {
            throw new ValidationError([{ field: `stages[${index}].fragments`, message: 'Stage must have at least one fragment (FR-026)' }]);
        }
        const effectiveStuckAction = stage.stuckAction || body.config.stuck_action;
        if (effectiveStuckAction === 'exit_stage' && !stage.exitStageId) {
            throw new ValidationError([{ field: `stages[${index}].exitStageId`, message: 'Required when stuck action is exit_stage' }]);
        }
    }

    const version = await repo.createVersion(id, body.config as any, body.stages as any, body.slots as any);
    reply.status(201);
    return version;
  });

  fastify.post('/v1/conversations/:id/funnel/reset', async (request) => {
    const { id } = request.params as { id: string };
    await repo.resetConversationState(id);
    return { status: 'reset' };
  });

  fastify.delete('/v1/funnels/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await repo.deleteFunnel(request.tenantId, id);
    reply.status(204);
  });
};
