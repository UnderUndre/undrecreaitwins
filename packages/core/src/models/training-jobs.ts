import { pgTable, uuid, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core';
import type { PersonaTraits } from '@undrecreaitwins/shared';

export const trainingJobs = pgTable(
  'training_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    personaId: uuid('persona_id').notNull(),
    sourceType: text('source_type').notNull(),
    sourceFileRef: text('source_file_ref').notNull(),
    status: text('status').notNull().default('pending'),
    progressPercent: integer('progress_percent').notNull().default(0),
    extractedTraits: jsonb('extracted_traits').$type<PersonaTraits>(),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPersonaIdx: index('idx_training_tenant_persona').on(table.tenantId, table.personaId),
    statusIdx: index('idx_training_status').on(table.status),
  }),
);
