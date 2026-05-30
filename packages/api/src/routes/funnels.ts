import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { FunnelRepository } from '@undrecreaitwins/core/services/funnel/funnel-repository.js';
import { ValidationError } from '@undrecreaitwins/shared';

const repo = new FunnelRepository();

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

  fastify.post('/v1/conversations/:id/funnel/reset', async (request, reply) => {
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
