import { pgTable, uuid, text, integer, jsonb, boolean } from 'drizzle-orm/pg-core';
import { funnelVersions } from './funnels.js';
import type { ResolutionCriteria } from '@undrecreaitwins/shared';

export const funnelStages = pgTable(
  'funnel_stages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    funnelVersionId: uuid('funnel_version_id').notNull().references(() => funnelVersions.id),
    name: text('name').notNull(),
    order: integer('order').notNull(),
    objective: text('objective'),
    resolutionCriteria: jsonb('resolution_criteria').notNull().$type<ResolutionCriteria>(),
    nextStageId: uuid('next_stage_id').references((): any => funnelStages.id),
    stuckAction: text('stuck_action'),
    exitStageId: uuid('exit_stage_id').references((): any => funnelStages.id),
    requiredSlots: jsonb('required_slots').notNull().$type<string[]>().default([]),
    requiresConfirmation: boolean('requires_confirmation').notNull().default(false),
    isAnytime: boolean('is_anytime').notNull().default(false),
  }
);
