import { eq } from 'drizzle-orm';
import { channelInstances } from '../models/index.js';
import { withTenantContext } from '../db.js';
import { NotFoundError } from '@undrecreaitwins/shared';

type ChannelRow = typeof channelInstances.$inferSelect;

export class ChannelRepository {
  async create(tenantId: string, data: {
    personaId: string;
    channelType: string;
    config: Record<string, unknown>;
  }): Promise<ChannelRow> {
    return withTenantContext(tenantId, async (tx) => {
      const [channel] = await tx
        .insert(channelInstances)
        .values({
          tenantId,
          personaId: data.personaId,
          channelType: data.channelType,
          config: data.config,
        })
        .returning();
      return channel!;
    });
  }

  async list(tenantId: string, limit = 20, offset = 0): Promise<{ data: ChannelRow[]; total: number }> {
    return withTenantContext(tenantId, async (tx) => {
      const data = await tx
        .select()
        .from(channelInstances)
        .limit(limit)
        .offset(offset);
      return { data, total: data.length };
    });
  }

  async delete(tenantId: string, id: string): Promise<void> {
    return withTenantContext(tenantId, async (tx) => {
      const [deleted] = await tx
        .delete(channelInstances)
        .where(eq(channelInstances.id, id))
        .returning({ id: channelInstances.id });
      if (!deleted) {
        throw new NotFoundError('Channel', id);
      }
    });
  }

  async updateStatus(tenantId: string, id: string, status: string): Promise<void> {
    return withTenantContext(tenantId, async (tx) => {
      await tx
        .update(channelInstances)
        .set({ status, lastHealthCheckAt: new Date() })
        .where(eq(channelInstances.id, id));
    });
  }
}
