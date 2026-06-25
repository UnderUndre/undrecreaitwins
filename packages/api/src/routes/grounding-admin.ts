import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PersonaRepository } from '@undrecreaitwins/core/services/persona-repository.js';
import { documentService } from '@undrecreaitwins/core/services/index.js';
import { ValidationError } from '@undrecreaitwins/shared';
import { getModelContextWindow } from '@undrecreaitwins/core/services/grounding/model-context-registry.js';

const repo = new PersonaRepository();
const BIG_CONTEXT_MINIMUM = 32_000;

const setPrioritySchema = z.object({
  priority: z.number().int().min(0),
});

const KNOWN_MODEL_WINDOWS: Record<string, number> = {
  'claude-sonnet-4-20250514': 200_000,
  'claude-3-haiku-20240307': 200_000,
};

export const groundingAdminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.patch('/v1/documents/:id/priority', async (request) => {
    const { id } = request.params as { id: string };
    const parseResult = setPrioritySchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const { priority } = parseResult.data;
    return documentService.updatePriority(request.tenantId, id, priority);
  });

  fastify.get('/v1/admin/model-windows', async () => {
    return { modelWindows: KNOWN_MODEL_WINDOWS };
  });

  fastify.get('/v1/admin/grounding-status/:personaId', async (request) => {
    const { personaId } = request.params as { personaId: string };
    const persona = await repo.getById(request.tenantId, personaId);

    const modelName = persona.modelPreferences?.model;
    const contextWindow = modelName ? getModelContextWindow(modelName) : null;
    const isAdequate = contextWindow !== null && contextWindow >= BIG_CONTEXT_MINIMUM;

    return {
      groundingMode: persona.groundingMode ?? null,
      truncationStrategy: persona.truncationStrategy,
      embeddingsStatus: persona.embeddingsStatus,
      bigContextMaxTokens: persona.bigContextMaxTokens ?? null,
      modelName: modelName ?? null,
      contextWindow,
      isAdequate,
    };
  });
};
