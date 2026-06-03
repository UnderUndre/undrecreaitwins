import { pgTable, uuid, text, timestamp, jsonb, boolean, doublePrecision, integer, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { personas } from './personas.js';
import { conversations } from './conversations.js';
import { messages } from './messages.js';

export const validatorModeEnum = pgEnum('validator_mode', ['active', 'dry-run']);
export const validatorVerdictEnum = pgEnum('validator_verdict', ['no_op', 'append_disclaimer', 'block', 'rewrite', 'error']);

export const validatorConfigs = pgTable(
  'validator_configs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    personaId: uuid('persona_id').notNull().references(() => personas.id),
    validatorName: text('validator_name').notNull(),
    mode: validatorModeEnum('mode').notNull().default('active'),
    config: jsonb('config').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPersonaNameIdx: uniqueIndex('validator_configs_tenant_persona_name_idx').on(table.tenantId, table.personaId, table.validatorName),
    tenantIdx: index('validator_configs_tenant_idx').on(table.tenantId),
  })
);

export const validatorRuns = pgTable(
  'validator_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    personaId: uuid('persona_id').notNull().references(() => personas.id),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
    messageId: uuid('message_id').references(() => messages.id),
    validatorName: text('validator_name').notNull(),
    verdict: validatorVerdictEnum('verdict').notNull(),
    confidence: doublePrecision('confidence'),
    matchedPatterns: jsonb('matched_patterns').default([]),
    originalContent: text('original_content').notNull(),
    remediatedContent: text('remediated_content'),
    latencyMs: integer('latency_ms'),
    isDryRun: boolean('is_dry_run').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPersonaIdx: index('validator_runs_tenant_persona_idx').on(table.tenantId, table.personaId),
    conversationIdx: index('validator_runs_conversation_idx').on(table.conversationId),
    tenantCreatedIdx: index('validator_runs_tenant_created_idx').on(table.tenantId, table.createdAt),
  })
);
