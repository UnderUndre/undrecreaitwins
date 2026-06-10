import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { personas } from './personas.js';
import { vector } from './types.js';

export const annotations = pgTable(
  'annotations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    personaId: text('persona_id')
      .notNull()
      .references(() => personas.id, { onDelete: 'cascade' }),
    originalQuery: text('original_query').notNull(),
    normalizedQuery: text('normalized_query').notNull(),
    badResponse: text('bad_response').notNull(),
    correctedResponse: text('corrected_response').notNull(),
    embedding: vector('embedding').notNull(),
    langfuseDatasetItemId: text('langfuse_dataset_item_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPersonaQueryIdx: uniqueIndex('annotations_tenant_persona_query_idx').on(
      table.tenantId,
      table.personaId,
      table.normalizedQuery,
    ),
    tenantPersonaIdx: index('annotations_tenant_persona_idx').on(table.tenantId, table.personaId),
  }),
);
