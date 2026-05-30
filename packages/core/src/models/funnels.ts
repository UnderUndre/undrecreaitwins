import { pgTable, uuid, text, timestamp, jsonb, boolean, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { personas } from './personas.js';
import type { FunnelConfig } from '@undrecreaitwins/shared';

export const funnelDefinitions = pgTable(
  'funnel_definitions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    personaId: uuid('persona_id').notNull().references(() => personas.id),
    name: text('name').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdx: index('funnel_defs_tenant_idx').on(table.tenantId),
    personaIdx: index('funnel_defs_persona_idx').on(table.personaId),
    tenantPersonaIdx: uniqueIndex('funnel_defs_tenant_persona_idx').on(table.tenantId, table.personaId),
  }),
);

export const funnelVersions = pgTable(
  'funnel_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    definitionId: uuid('definition_id').notNull().references(() => funnelDefinitions.id),
    versionNumber: integer('version_number').notNull(),
    config: jsonb('config').notNull().$type<FunnelConfig>(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    defVersionIdx: uniqueIndex('funnel_versions_def_version_idx').on(table.definitionId, table.versionNumber),
    activeVersionIdx: uniqueIndex('funnel_versions_active_idx').on(table.definitionId).where(sql`${table.isActive} = true`),
  }),
);
