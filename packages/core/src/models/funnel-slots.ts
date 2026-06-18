import { pgTable, uuid, text, jsonb, boolean } from 'drizzle-orm/pg-core';
import { funnelVersions } from './funnels.js';
import { funnelStages } from './funnel-stages.js';

export const funnelSlots = pgTable(
  'funnel_slots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    funnelVersionId: uuid('funnel_version_id').notNull().references(() => funnelVersions.id),
    stageId: uuid('stage_id').references(() => funnelStages.id),
    name: text('name').notNull(),
    description: text('description'),
    validationRules: jsonb('validation_rules'),
    locked: boolean('locked').notNull().default(false),
    enumValues: jsonb('enum_values').$type<string[]>(),
  }
);
