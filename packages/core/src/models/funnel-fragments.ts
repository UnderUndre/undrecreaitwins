import { pgTable, uuid, text, jsonb, real, pgEnum, boolean } from 'drizzle-orm/pg-core';
import { funnelVersions } from './funnels.js';
import { funnelStages } from './funnel-stages.js';
import type { TriggerDefinition } from '@undrecreaitwins/shared';

export const fragmentTypeEnum = pgEnum('fragment_type', ['normal', 'objection']);
export const deliveryModeEnum = pgEnum('delivery_mode', ['verbatim', 'template', 'llm']);

export const funnelFragments = pgTable(
  'funnel_fragments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    funnelVersionId: uuid('funnel_version_id').notNull().references(() => funnelVersions.id),
    stageId: uuid('stage_id').notNull().references(() => funnelStages.id),
    type: fragmentTypeEnum('type').notNull().default('normal'),
    content: text('content').notNull(),
    triggers: jsonb('triggers').notNull().$type<TriggerDefinition>(),
    scoreWeight: real('score_weight').notNull().default(1.0),
    deliveryMode: deliveryModeEnum('delivery_mode').notNull().default('llm'),
    adaptiveIntro: boolean('adaptive_intro').notNull().default(false),
    mediaUrl: text('media_url'),
    deliveryCondition: jsonb('delivery_condition'),
  }
);
