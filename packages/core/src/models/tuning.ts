import { pgTable, text, uuid, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { personas } from './personas.js';
import type { ConfidenceLevel } from '../types/tuning.js';

export const tuningDrafts = pgTable('tuning_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull(),
  personaId: text('persona_id').notNull().references(() => personas.id, { onDelete: 'cascade' }),
  method: text('method', { enum: ['doc-extraction', 'template-bootstrap', 'interview', 'self-tuner'] }).notNull(),
  status: text('status', { enum: ['generating', 'ready', 'failed', 'activated', 'superseded', 'rolled-back'] }).notNull().default('generating'),
  confidence: text('confidence', { enum: ['high', 'medium', 'low'] }).$type<ConfidenceLevel | null>(),
  systemPrompt: text('system_prompt'),
  funnelConfig: jsonb('funnel_config'),
  validatorToggles: jsonb('validator_toggles'),
  diffSections: jsonb('diff_sections'),
  previousSnapshot: jsonb('previous_snapshot'),
  signals: jsonb('signals'),
  error: text('error'),
  reviewVerdict: text('review_verdict', { enum: ['approved', 'rejected'] }),
  reviewNotes: text('review_notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
}, (table) => {
  return {
    idxTuningDraftsPersonaStatus: index('idx_tuning_drafts_persona_status').on(table.personaId, table.status),
    idxTuningDraftsTenantStatus: index('idx_tuning_drafts_tenant_status').on(table.tenantId, table.status),
    idxTuningDraftsCreatedAt: index('idx_tuning_drafts_created_at').on(table.createdAt.desc()),
    idxTuningDraftsPersonaGenerating: uniqueIndex('idx_tuning_drafts_persona_generating')
      .on(table.personaId)
      .where(sql`status = 'generating'`),
  };
});
