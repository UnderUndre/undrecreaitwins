import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { personas } from './personas.js';
import { vector } from './types.js';

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    personaId: uuid('persona_id')
      .notNull()
      .references(() => personas.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status').notNull().$type<'pending' | 'parsing' | 'ready' | 'failed'>(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPersonaIdx: index('documents_tenant_persona_idx').on(table.tenantId, table.personaId),
  }),
);

export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    personaId: uuid('persona_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantPersonaIdx: index('document_chunks_tenant_persona_idx').on(table.tenantId, table.personaId),
  }),
);
