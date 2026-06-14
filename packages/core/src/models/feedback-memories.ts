import { pgTable, uuid, text, real, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { personas } from './personas.js';
import { conversations } from './conversations.js';
import { vector } from './types.js';

export const feedbackStatusEnum = pgEnum('feedback_status', ['pending', 'active', 'archived']);

export const feedbackMemories = pgTable('feedback_memories', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: text('tenant_id').notNull(),
  personaId: text('persona_id').notNull().references(() => personas.id, { onDelete: 'cascade' }),
  contextEmbedding: vector('context_embedding', 1024).notNull(),
  lesson: text('lesson').notNull(),
  status: feedbackStatusEnum('status').notNull().default('pending'),
  operatorRole: text('operator_role'),
  weight: real('weight').default(1.0),
  sourceConversationId: uuid('source_conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantPersonaStatusIdx: index('feedback_memories_tenant_persona_status_idx')
    .on(table.tenantId, table.personaId, table.status),
}));
