import type { FastifyPluginAsync } from 'fastify';
import { withTenantContext } from '@undrecreaitwins/core/db.js';
import { conversations, messages } from '@undrecreaitwins/core/models/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { NotFoundError } from '@undrecreaitwins/shared';

function toApiConversation(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    tenant_id: row.tenantId as string,
    persona_id: row.personaId as string,
    channel_id: (row.channelId as string) ?? null,
    external_user_id: row.externalUserId as string,
    summary: (row.summary as string) ?? null,
    started_at: (row.startedAt as Date)?.toISOString(),
    ended_at: (row.endedAt as Date)?.toISOString() ?? null,
    message_count: row.messageCount as number,
  };
}

function toApiMessage(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    conversation_id: row.conversationId as string,
    role: row.role as string,
    content: row.content as string,
    metadata: (row.metadata as Record<string, unknown>) || {},
    created_at: (row.createdAt as Date)?.toISOString(),
  };
}

export const conversationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/conversations', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const personaId = query.persona_id;

    const result = await withTenantContext(request.tenantId, async (tx) => {
      const conditions = [eq(conversations.tenantId, request.tenantId)];
      if (personaId) {
        conditions.push(eq(conversations.personaId, personaId));
      }

      const data = await tx
        .select()
        .from(conversations)
        .where(and(...conditions))
        .orderBy(desc(conversations.startedAt))
        .limit(limit)
        .offset(offset);

      return data;
    });

    return {
      data: result.map((r) => toApiConversation(r as Record<string, unknown>)),
      limit,
      offset,
      total: result.length,
    };
  });

  fastify.get('/v1/conversations/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const result = await withTenantContext(request.tenantId, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, request.tenantId)))
        .limit(1);

      if (!conv) {
        throw new NotFoundError('Conversation', id);
      }

      return tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(messages.createdAt)
        .limit(limit)
        .offset(offset);
    });

    return {
      data: result.map((r) => toApiMessage(r as Record<string, unknown>)),
      limit,
      offset,
      total: result.length,
    };
  });
};
