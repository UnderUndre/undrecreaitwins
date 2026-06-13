import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { personas } from './personas.js';

/**
 * Delivery ledger (FR-011).
 *
 * Tracks the lifecycle of every outbound message in channel conversations.
 * Provides atomic CAS semantics to prevent double-delivery (late original vs retry race).
 *
 * State machine: pending → fallback_sent | final_delivered
 * Only ONE final delivery wins via CAS: UPDATE … WHERE state != 'final_delivered'
 *
 * Sandbox conversations bypass this ledger entirely.
 */
export const deliveryRecords = pgTable(
  'delivery_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    /** Original inbound channel message ID — unique per tenant+conversation. */
    channelMessageId: text('channel_message_id').notNull(),
    /** Delivery state: pending → fallback_sent → final_delivered (or pending → final_delivered). */
    state: text('state')
      .notNull()
      .$type<'pending' | 'fallback_sent' | 'final_delivered'>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /** Prevents duplicate ledger rows for the same inbound message. */
    msgUniqueIdx: uniqueIndex('delivery_records_msg_uq').on(
      table.tenantId,
      table.conversationId,
      table.channelMessageId,
    ),
  }),
);

/**
 * LLM retry job queue (FR-002).
 *
 * Stores full message payload for retry after LLM failure.
 * Unique per inbound message to prevent duplicate retry enqueues.
 * Job lifecycle: pending → in_progress → completed | dlq
 * Delivery state lives separately in delivery_records.
 */
export const llmRetryJobs = pgTable(
  'llm_retry_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    personaId: text('persona_id')
      .notNull()
      .references(() => personas.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    /** Original inbound message ID — joins delivery_records. */
    channelMessageId: text('channel_message_id').notNull(),
    /** Full LLM messages array for retry. Contains PII — retention enforced. */
    messagesPayload: jsonb('messages_payload').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    /** Job lifecycle: pending → in_progress → completed | dlq. */
    status: text('status')
      .notNull()
      .$type<'pending' | 'in_progress' | 'completed' | 'dlq'>()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    /** Prevents duplicate retry jobs for the same inbound message. */
    msgUniqueIdx: uniqueIndex('llm_retry_jobs_msg_uq').on(
      table.tenantId,
      table.conversationId,
      table.channelMessageId,
    ),
    /** For worker polling: find jobs ready to process. */
    statusNextRetryIdx: index('llm_retry_jobs_status_next_retry_idx').on(
      table.status,
      table.nextRetryAt,
    ),
    /** Per-persona filtering. */
    personaIdx: index('llm_retry_jobs_persona_idx').on(table.personaId),
  }),
);
