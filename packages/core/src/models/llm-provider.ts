import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  real,
  boolean,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Per-assistant LLM provider override.
 * When present, the runtime uses these credentials/model params
 * instead of the tenant-level default.
 */
export const llmProviderConfig = pgTable(
  'llm_provider_config',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    personaId: text('persona_id').notNull(),
    providerType: text('provider_type').notNull().default('custom'),
    baseUrl: text('base_url').notNull(),
    modelId: text('model_id').notNull(),
    apiKeyCiphertext: text('api_key_ciphertext').notNull(),
    apiKeyRef: text('api_key_ref').notNull(),
    temperature: real('temperature'),
    maxTokens: integer('max_tokens'),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    personaUniqueIdx: uniqueIndex('llm_provider_config_persona_idx').on(table.personaId),
    tenantIdx: index('llm_provider_config_tenant_idx').on(table.tenantId),
  }),
);

/**
 * Tenant-level default LLM configuration.
 * Serves as the fallback when no per-assistant override exists.
 */
export const tenantLlmDefault = pgTable(
  'tenant_llm_default',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    providerType: text('provider_type').notNull().default('custom'),
    baseUrl: text('base_url').notNull(),
    modelId: text('model_id').notNull(),
    apiKeyCiphertext: text('api_key_ciphertext').notNull(),
    apiKeyRef: text('api_key_ref').notNull(),
    temperature: real('temperature'),
    maxTokens: integer('max_tokens'),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantUniqueIdx: uniqueIndex('tenant_llm_default_tenant_idx').on(table.tenantId),
  }),
);
