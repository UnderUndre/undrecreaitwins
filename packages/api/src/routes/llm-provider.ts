import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '@undrecreaitwins/core/db.js';
import { ProviderConfigService } from '@undrecreaitwins/core/services/llm-provider/provider-config.service.js';
import { testProviderConnection } from '@undrecreaitwins/core/services/llm-provider/test-connection.js';
import { ValidationError, NotFoundError } from '@undrecreaitwins/shared';

const service = new ProviderConfigService(db);

const providerConfigSchema = z.object({
  provider_type: z.string().min(1).default('custom'),
  base_url: z.string().url(),
  model_id: z.string().min(1),
  api_key: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).optional(),
  enabled: z.boolean().optional(),
  version: z.number().int().min(0).optional(),
});

const testConnectionSchema = z.object({
  base_url: z.string().url(),
  model_id: z.string().min(1),
  api_key: z.string().min(1).optional(),
  persona_id: z.string().uuid().optional(),
});

export const llmProviderRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Tenant level ──────────────────────────────────────────────────────

  fastify.get('/v1/llm-provider/tenant', async (request) => {
    const config = await service.getTenantDefault(request.tenantId);
    if (!config) throw new NotFoundError('TenantLLMDefault', request.tenantId);
    return config;
  });

  fastify.put('/v1/llm-provider/tenant', async (request) => {
    const parseResult = providerConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;
    return service.upsertTenantDefault(request.tenantId, {
      providerType: body.provider_type,
      baseUrl: body.base_url,
      modelId: body.model_id,
      apiKey: body.api_key,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      enabled: body.enabled,
      expectedVersion: body.version,
    });
  });

  fastify.delete('/v1/llm-provider/tenant', async (request, reply) => {
    const deleted = await service.deleteTenantDefault(request.tenantId);
    if (!deleted) throw new NotFoundError('TenantLLMDefault', request.tenantId);
    reply.status(204);
  });

  // ── Persona level ─────────────────────────────────────────────────────

  fastify.get('/v1/personas/:id/llm-provider', async (request) => {
    const { id } = request.params as { id: string };
    const config = await service.getAssistantOverride(request.tenantId, id);
    if (!config) throw new NotFoundError('PersonaLLMOverride', id);
    return config;
  });

  fastify.put('/v1/personas/:id/llm-provider', async (request) => {
    const { id } = request.params as { id: string };
    const parseResult = providerConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;
    return service.upsertAssistantOverride(request.tenantId, id, {
      providerType: body.provider_type,
      baseUrl: body.base_url,
      modelId: body.model_id,
      apiKey: body.api_key,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      enabled: body.enabled,
      expectedVersion: body.version,
    });
  });

  fastify.delete('/v1/personas/:id/llm-provider', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await service.deleteAssistantOverride(request.tenantId, id);
    if (!deleted) throw new NotFoundError('PersonaLLMOverride', id);
    reply.status(204);
  });

  // ── Connection testing ────────────────────────────────────────────────

  fastify.post('/v1/llm-provider/test', async (request) => {
    const parseResult = testConnectionSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;

    let apiKey = body.api_key;

    // Key merge logic: if api_key omitted, try to fetch existing (with tenant isolation)
    if (!apiKey) {
      if (body.persona_id) {
        apiKey = (await service.getDecryptedAssistantKey(request.tenantId, body.persona_id)) || undefined;
      } else {
        apiKey = (await service.getDecryptedTenantKey(request.tenantId)) || undefined;
      }

      if (!apiKey) {
        throw new ValidationError([{ field: 'api_key', message: 'api_key is required for new configurations' }]);
      }
    }

    return testProviderConnection(body.base_url, body.model_id, apiKey);
  });
};
