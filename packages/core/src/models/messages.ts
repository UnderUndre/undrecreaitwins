import { pgTable, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import type { MessageMetadata } from '@undrecreaitwins/shared';

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').notNull().$type<MessageMetadata>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationCreatedIdx: index('idx_messages_conversation').on(table.conversationId, table.createdAt),
  }),
);
