import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    personaId: uuid('persona_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantCreatedIdx: index('idx_usage_tenant_created').on(table.tenantId, table.createdAt),
    tenantPersonaCreatedIdx: index('idx_usage_tenant_persona').on(table.tenantId, table.personaId, table.createdAt),
  }),
);
