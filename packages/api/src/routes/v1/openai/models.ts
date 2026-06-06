import type { FastifyPluginAsync } from 'fastify';
import { PersonaRepository } from '@undrecreaitwins/core/services/persona-repository.js';

const personaRepo = new PersonaRepository();

const modelCache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

export const publicModelsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/models', async (request) => {
    const tenantId = request.tenantId;

    const cached = modelCache.get(tenantId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    const { data: personas } = await personaRepo.list(tenantId, 200, 0);

    const result = {
      object: 'list' as const,
      data: personas.map((p: any) => ({
        id: `asst_${p.slug}`,
        object: 'model' as const,
        created: Math.floor(new Date(p.createdAt).getTime() / 1000),
        owned_by: 'ai-twins',
      })),
    };

    modelCache.set(tenantId, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });

    return result;
  });
};
