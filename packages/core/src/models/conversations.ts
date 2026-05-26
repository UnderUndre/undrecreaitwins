import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    personaId: uuid('persona_id').notNull(),
    channelId: uuid('channel_id'),
    externalUserId: text('external_user_id').notNull(),
    summary: text('summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    messageCount: integer('message_count').notNull().default(0),
  },
  (table) => ({
    tenantPersonaIdx: index('idx_conversations_tenant_persona').on(table.tenantId, table.personaId),
    tenantIdx: index('idx_conversations_tenant').on(table.tenantId),
  }),
);
