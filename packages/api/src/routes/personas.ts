import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PersonaRepository } from '@undrecreaitwins/core/services/persona-repository.js';
import { ValidationError } from '@undrecreaitwins/shared';
import type { PersonaTraits, ModelPreferences } from '@undrecreaitwins/shared';

const repo = new PersonaRepository();

const createPersonaSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/),
  system_prompt: z.string().min(1),
  traits: z.record(z.unknown()).optional(),
  model_preferences: z.record(z.unknown()).optional(),
  annotation_similarity_threshold: z.number().min(0).max(1).optional(),
});

const updatePersonaSchema = z.object({
  version: z.number().int().min(0).optional(),
  name: z.string().min(1).max(200).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/).optional(),
  system_prompt: z.string().min(1).optional(),
  traits: z.record(z.unknown()).optional(),
  model_preferences: z.record(z.unknown()).optional(),
  annotation_similarity_threshold: z.number().min(0).max(1).optional(),
});

function toApiPersona(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    tenant_id: row.tenantId as string,
    name: row.name as string,
    slug: row.slug as string,
    system_prompt: row.systemPrompt as string,
    traits: (row.traits as PersonaTraits) || {},
    model_preferences: (row.modelPreferences as ModelPreferences) || {},
    annotation_similarity_threshold: row.annotationSimilarityThreshold as number,
    has_annotations: row.hasAnnotations as boolean,
    created_at: (row.createdAt as Date)?.toISOString(),
    updated_at: (row.updatedAt as Date)?.toISOString(),
    version: row.version !== undefined && row.version !== null
      ? Number(row.version as bigint)
      : undefined,
  };
}

export const personaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/personas', async (request, reply) => {
    const parseResult = createPersonaSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;
    const persona = await repo.create(request.tenantId, {
      id: body.id,
      name: body.name,
      slug: body.slug,
      systemPrompt: body.system_prompt,
      traits: body.traits as PersonaTraits | undefined,
      modelPreferences: body.model_preferences as ModelPreferences | undefined,
      annotationSimilarityThreshold: body.annotation_similarity_threshold,
    });
    reply.status(201);
    return toApiPersona(persona as Record<string, unknown>);
  });

  fastify.post('/v1/assistants', async (request, reply) => {
    const parseResult = createPersonaSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;
    const persona = await repo.create(request.tenantId, {
      id: body.id,
      name: body.name,
      slug: body.slug,
      systemPrompt: body.system_prompt,
      traits: body.traits as PersonaTraits | undefined,
      modelPreferences: body.model_preferences as ModelPreferences | undefined,
      annotationSimilarityThreshold: body.annotation_similarity_threshold,
    });
    reply.status(201);
    return toApiPersona(persona as Record<string, unknown>);
  });

  fastify.get('/v1/personas', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const parsedLimit = Number(query.limit);
    const limit = !Number.isFinite(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);
    const parsedOffset = Number(query.offset);
    const offset = !Number.isFinite(parsedOffset) ? 0 : Math.max(parsedOffset, 0);
    const result = await repo.list(request.tenantId, limit, offset);
    return {
      data: result.data.map((p: Record<string, unknown>) => toApiPersona(p)),
      limit,
      offset,
      total: result.total,
    };
  });

  fastify.get('/v1/personas/:id', async (request) => {
    const { id } = request.params as { id: string };
    const persona = await repo.getById(request.tenantId, id);
    return toApiPersona(persona as Record<string, unknown>);
  });

  fastify.patch('/v1/personas/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parseResult = updatePersonaSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;

    const ifMatch = request.headers['if-match'];
    let expectedVersion: number | undefined;
    if (ifMatch) {
      const cleanIfMatch = (ifMatch as string)
        .replace(/^W\//, '')
        .replace(/^"|"$/g, '')
        .trim();
      try {
        expectedVersion = Number(cleanIfMatch);
        if (Number.isNaN(expectedVersion)) {
          throw new Error();
        }
      } catch {
        throw new ValidationError([
          { field: 'If-Match', message: `Invalid If-Match header value: ${ifMatch}` },
        ]);
      }
    } else if (body.version !== undefined) {
      expectedVersion = Number(body.version);
    }

    const persona = await repo.update(request.tenantId, id, {
      name: body.name,
      slug: body.slug,
      systemPrompt: body.system_prompt,
      traits: body.traits as PersonaTraits | undefined,
      modelPreferences: body.model_preferences as ModelPreferences | undefined,
      annotationSimilarityThreshold: body.annotation_similarity_threshold,
      expectedVersion,
    });
    return toApiPersona(persona as Record<string, unknown>);
  });

  fastify.delete('/v1/personas/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await repo.delete(request.tenantId, id);
    reply.status(204);
  });
};
