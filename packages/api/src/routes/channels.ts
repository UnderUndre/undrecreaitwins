import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ChannelRepository } from '@undrecreaitwins/core/services/channel-repository.js';
import { ValidationError } from '@undrecreaitwins/shared';

const repo = new ChannelRepository();

const createChannelSchema = z.object({
  persona_id: z.string().uuid(),
  channel_type: z.enum(['telegram', 'whatsapp_evolution']),
  config: z.record(z.unknown()),
});

function toApiChannel(row: Record<string, unknown>) {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    persona_id: row.personaId,
    channel_type: row.channelType,
    config: row.config,
    status: row.status,
    last_health_check_at: (row.lastHealthCheckAt as Date | null)?.toISOString() ?? null,
    created_at: (row.createdAt as Date)?.toISOString(),
  };
}

export const channelRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/channels', async (request, reply) => {
    const parseResult = createChannelSchema.safeParse(request.body);
    if (!parseResult.success) {
      throw new ValidationError(
        parseResult.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    const body = parseResult.data;
    const req = request as unknown as { tenantId: string };
    const channel = await repo.create(req.tenantId, {
      personaId: body.persona_id,
      channelType: body.channel_type,
      config: body.config,
    });
    reply.status(201);
    return toApiChannel(channel as unknown as Record<string, unknown>);
  });

  fastify.get('/v1/channels', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const parsedLimit = Number(query.limit);
    const limit = !Number.isFinite(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 100);
    const parsedOffset = Number(query.offset);
    const offset = !Number.isFinite(parsedOffset) ? 0 : Math.max(parsedOffset, 0);
    const req = request as unknown as { tenantId: string };
    const result = await repo.list(req.tenantId, limit, offset);
    return {
      data: result.data.map((c: Record<string, unknown>) => toApiChannel(c)),
      limit,
      offset,
      total: result.total,
    };
  });

  fastify.delete('/v1/channels/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const req = request as unknown as { tenantId: string };
    await repo.delete(req.tenantId, id);
    reply.status(204);
  });
};
