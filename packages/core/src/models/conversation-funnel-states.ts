import { pgTable, uuid, integer, jsonb, timestamp, bigint } from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';
import { funnelVersions } from './funnels.js';
import { funnelStages } from './funnel-stages.js';
import type { CapturedSlot } from '@undrecreaitwins/shared';

export const conversationFunnelStates = pgTable(
  'conversation_funnel_states',
  {
    conversationId: uuid('conversation_id').primaryKey().references(() => conversations.id),
    funnelVersionId: uuid('funnel_version_id').notNull().references(() => funnelVersions.id),
    currentStageId: uuid('current_stage_id').notNull().references(() => funnelStages.id),
    consecutiveStuckCount: integer('consecutive_stuck_count').notNull().default(0),
    capturedSlots: jsonb('captured_slots').notNull().$type<Record<string, CapturedSlot>>().default({}),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  }
);
