import { pgTable, uuid, text, timestamp, integer, index, boolean, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';

export const followupRules = pgTable(
  'followup_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    triggerStaleMinutes: integer('trigger_stale_minutes').notNull(),
    conditions: jsonb('conditions').notNull().default({}),
    backoff: jsonb('backoff').notNull().$type<number[]>().default([]),
    maxAttempts: integer('max_attempts').notNull().default(3),
    minIntervalMinutes: integer('min_interval_minutes').notNull().default(1440),
    template: text('template').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantActiveIdx: index('idx_followup_rules_tenant_active').on(table.tenantId, table.isActive),
  }),
);

export const followupAttempts = pgTable(
  'followup_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
    ruleId: uuid('rule_id').notNull().references(() => followupRules.id),
    tenantId: text('tenant_id').notNull(),
    status: text('status').notNull(), // 'scheduled', 'processing', 'sent', 'failed', 'opted_out', 'expired'
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyIdx: uniqueIndex('idx_followup_attempts_idempotency').on(table.idempotencyKey),
    tenantStatusScheduledIdx: index('idx_followup_attempts_tenant_status_scheduled').on(table.tenantId, table.status, table.scheduledAt),
    tenantStatusClaimedIdx: index('idx_followup_attempts_tenant_status_claimed').on(table.tenantId, table.status, table.claimedAt),
  }),
);
