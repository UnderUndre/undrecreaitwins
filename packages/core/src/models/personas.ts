import { pgTable, uuid, text, timestamp, jsonb, bigint, uniqueIndex, index } from 'drizzle-orm/pg-core';
import type { PersonaTraits, ModelPreferences } from '@undrecreaitwins/shared';

export const personas = pgTable(
  'personas',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    traits: jsonb('traits').notNull().$type<PersonaTraits>().default({}),
    modelPreferences: jsonb('model_preferences').notNull().$type<ModelPreferences>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: bigint('version', { mode: 'bigint' }).notNull().default(0n),
  },
  (table) => ({
    tenantSlugIdx: uniqueIndex('personas_tenant_slug_idx').on(table.tenantId, table.slug),
    tenantIdx: index('personas_tenant_idx').on(table.tenantId),
  }),
);
