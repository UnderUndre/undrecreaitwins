import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

export const channelInstances = pgTable(
  'channel_instances',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    personaId: uuid('persona_id').notNull(),
    channelType: text('channel_type').notNull(),
    config: jsonb('config').notNull().$type<Record<string, unknown>>(),
    status: text('status').notNull().default('disconnected'),
    lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index('idx_channels_tenant').on(table.tenantId),
    tenantPersonaIdx: index('idx_channels_tenant_persona').on(table.tenantId, table.personaId),
  }),
);
