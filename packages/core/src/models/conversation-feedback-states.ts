import { pgTable, uuid, jsonb, integer, timestamp, text } from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';

export const conversationFeedbackStates = pgTable('conversation_feedback_states', {
  conversationId: uuid('conversation_id').primaryKey().references(() => conversations.id, { onDelete: 'cascade' }),
  appliedFeedbackIds: jsonb('applied_feedback_ids').notNull().$type<string[]>().default([]),
  messageCount: integer('message_count').notNull().default(0),
  lastStageLabel: text('last_stage_label'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
