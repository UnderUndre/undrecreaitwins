import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Redis } from 'ioredis';
import pino from 'pino';
import { ChannelRepository } from '@undrecreaitwins/core/services/channel-repository.js';
import { ValidationError } from '@undrecreaitwins/shared';
import type { ChannelStatus, ChannelHealth } from '@undrecreaitwins/shared';

const logger = pino({ name: 'channel-routes' });
const repo = new ChannelRepository();
const healthRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const ALL_CHANNEL_TYPES = [
  'telegram', 'whatsapp_evolution', 'discord', 'slack', 'mattermost',
  'dingtalk', 'feishu', 'wecom', 'matrix', 'email', 'sms', 'webhook', 'homeassistant',
] as const;

const createChannelSchema = z.object({
  persona_id: z.string().uuid(),
  channel_type: z.enum(ALL_CHANNEL_TYPES),
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

function computeOverallStatus(statuses: ChannelStatus[]): 'healthy' | 'degraded' | 'down' {
  if (statuses.length === 0) return 'healthy';

  const allDown = statuses.every((s) => s === 'error');
  if (allDown) return 'down';

  const anyNonActive = statuses.some((s) => s !== 'active');
  if (anyNonActive) return 'degraded';

  return 'healthy';
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
    const tenantId = (request as FastifyRequest).tenantId;
    const channel = await repo.create(tenantId, {
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
    const tenantId = (request as FastifyRequest).tenantId;
    const result = await repo.list(tenantId, limit, offset);
    return {
      data: result.data.map((c: Record<string, unknown>) => toApiChannel(c)),
      limit,
      offset,
      total: result.total,
    };
  });

  fastify.delete('/v1/channels/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = (request as FastifyRequest).tenantId;
    await repo.delete(tenantId, id);
    reply.status(204);
  });

  // T021: GET /v1/channels/health — aggregated channel health endpoint
  fastify.get('/v1/channels/health', async (request) => {
    const tenantId = (request as FastifyRequest).tenantId;

    // Check Redis for cached aggregation first
    const cacheKey = `channels:health:${tenantId}`;
    const cached = await healthRedis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        logger.warn({ tenantId }, 'Failed to parse cached health aggregation, recomputing');
      }
    }

    // Query all channel instances for this tenant
    const { data: channels } = await repo.list(tenantId, 1000, 0);

    const channelHealthMap: Record<string, ChannelHealth> = {};
    const statuses: ChannelStatus[] = [];

    for (const channel of channels) {
      const channelId = channel.id as string;

      // Check Redis for per-channel cached health
      const perChannelKey = `channels:health:${channelId}`;
      let health: ChannelHealth;

      const cachedHealth = await healthRedis.get(perChannelKey);
      if (cachedHealth) {
        try {
          health = JSON.parse(cachedHealth) as ChannelHealth;
        } catch {
          // Fall back to DB status
          health = {
            status: (channel.status as ChannelStatus) || 'disconnected',
            lastPingAt: channel.lastHealthCheckAt ?? undefined,
          };
        }
      } else {
        // Use last known status from DB
        health = {
          status: (channel.status as ChannelStatus) || 'disconnected',
          lastPingAt: channel.lastHealthCheckAt ?? undefined,
        };
      }

      channelHealthMap[channelId] = health;
      statuses.push(health.status);
    }

    const overall = computeOverallStatus(statuses);

    const result = {
      channels: channelHealthMap,
      overall,
    };

    // Cache the aggregation with 30s TTL
    await healthRedis.set(cacheKey, JSON.stringify(result), 'EX', 30);

    return result;
  });
};
