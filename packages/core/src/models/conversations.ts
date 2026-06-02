import { pgTable, uuid, text, timestamp, integer, index, boolean } from 'drizzle-orm/pg-core';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    personaId: uuid('persona_id').notNull(),
    channelId: uuid('channel_id'),
    externalUserId: text('external_user_id').notNull(),
    summary: text('summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    messageCount: integer('message_count').notNull().default(0),
    isTestThread: boolean('is_test_thread').notNull().default(false),
    source: text('source'),
    status: text('status').notNull().default('active'), // e.g., 'active', 'closed', 'operator_assigned'
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    tags: text('tags').array().notNull().default([]),
    // Re-engagement fields
    needsReengagement: boolean('needs_reengagement').notNull().default(true),
    lastReengagementAt: timestamp('last_reengagement_at', { withTimezone: true }),
    reengagementCount: integer('reengagement_count').notNull().default(0),
    optedOut: boolean('opted_out').notNull().default(false),
  },
  (table) => ({
    tenantPersonaIdx: index('idx_conversations_tenant_persona').on(table.tenantId, table.personaId),
    tenantIdx: index('idx_conversations_tenant').on(table.tenantId),
    reengagementScanIdx: index('idx_conversations_reengagement_scan').on(table.tenantId, table.needsReengagement, table.lastMessageAt),
  }),
);
