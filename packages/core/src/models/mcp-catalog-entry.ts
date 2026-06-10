import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  index,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { personas } from './personas.js';

export const mcpScopeEnum = pgEnum('mcp_scope', ['tenant', 'platform']);
export const mcpTransportEnum = pgEnum('mcp_transport', ['http', 'stdio']);

export const mcpCatalogEntry = pgTable(
  'mcp_catalog_entry',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    scope: mcpScopeEnum('scope').notNull().default('tenant'),
    name: text('name').notNull(),
    transport: mcpTransportEnum('transport').notNull().default('http'),
    url: text('url'),
    command: text('command'),
    args: jsonb('args').$type<unknown[]>(),
    authCiphertext: text('auth_ciphertext'),
    authRef: text('auth_ref'),
    toolsInclude: jsonb('tools_include').$type<string[]>(),
    toolsExclude: jsonb('tools_exclude').$type<string[]>(),
    timeoutMs: integer('timeout_ms').notNull().default(30000),
    tlsVerify: boolean('tls_verify').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantNameUnique: uniqueIndex('mcp_catalog_entry_tenant_name_idx').on(table.tenantId, table.name),
    tenantIdx: index('mcp_catalog_entry_tenant_idx').on(table.tenantId),
    idTenantUnique: uniqueIndex('mcp_catalog_entry_id_tenant_idx').on(table.id, table.tenantId),
  }),
);

export const assistantMcpBinding = pgTable(
  'assistant_mcp_binding',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    personaId: text('persona_id').notNull().references(() => personas.id, { onDelete: 'cascade' }),
    catalogEntryId: uuid('catalog_entry_id').notNull().references(() => mcpCatalogEntry.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    toolOverrides: jsonb('tool_overrides').$type<Array<{
      name: string;
      include?: boolean;
      isWrite?: boolean;
      requiresConfirmation?: boolean;
    }>>().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    personaEntryUnique: uniqueIndex('assistant_mcp_binding_persona_entry_idx').on(table.personaId, table.catalogEntryId),
    tenantIdx: index('assistant_mcp_binding_tenant_idx').on(table.tenantId),
    personaIdx: index('assistant_mcp_binding_persona_idx').on(table.personaId),
  }),
);
