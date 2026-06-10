import { pgTable, text, timestamp, jsonb, bigint, uniqueIndex, index, real, boolean } from 'drizzle-orm/pg-core';
import type { PersonaTraits, ModelPreferences } from '@undrecreaitwins/shared';

export const personas = pgTable(
  'personas',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    traits: jsonb('traits').notNull().$type<PersonaTraits>().default({}),
    modelPreferences: jsonb('model_preferences').notNull().$type<ModelPreferences>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    annotationSimilarityThreshold: real('annotation_similarity_threshold').notNull().default(0.7),
    hasAnnotations: boolean('has_annotations').notNull().default(false),
    agentEnabled: boolean('agent_enabled').notNull().default(false),
    toolAllowlist: jsonb('tool_allowlist').notNull().default([]),
    agentConfig: jsonb('agent_config').notNull().default({}),
  },
  (table) => ({
    tenantSlugIdx: uniqueIndex('personas_tenant_slug_idx').on(table.tenantId, table.slug),
    tenantIdx: index('personas_tenant_idx').on(table.tenantId),
  }),
);
