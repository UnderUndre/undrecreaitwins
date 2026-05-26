# Data Model: Twin Engine Foundation

**Spec**: `specs/001-twin-engine-foundation/spec.md`
**Storage**: PostgreSQL ≥15 with Drizzle ORM
**Migration tool**: drizzle-kit

## Entity-Relationship Overview

```
tenant (reference only)
  ├── persona (1:N)
  │   ├── conversation (1:N)
  │   │   └── message (1:N)
  │   └── training_job (1:N)
  ├── channel_instance (1:N per persona)
  └── usage_event (1:N per persona)
```

## Tables

### tenants (reference table)

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, default gen_random_uuid() | Opaque identifier — twin-engine does NOT manage tenant lifecycle. Always UUID, never free-form string. |
| status | text | NOT NULL, default 'active' | 'active', 'suspended', 'deleted' |
| created_at | timestamptz | NOT NULL, default now() | |

No RLS on tenants — this is a reference table. Tenant CRUD is managed externally (Dvoiniki SaaS or manual SQL for OSS users).

### personas

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | |
| tenant_id | uuid | NOT NULL, FK tenants(id) ON DELETE CASCADE | Composite unique with slug |
| name | text | NOT NULL | Display name |
| slug | text | NOT NULL | URL-safe, unique per tenant |
| system_prompt | text | NOT NULL | Core personality prompt |
| traits | jsonb | NOT NULL, default '{}' | Extracted + manual traits |
| model_preferences | jsonb | NOT NULL, default '{}' | {provider, model, temperature, max_tokens, fallback_model} |

| created_at | timestamptz | NOT NULL, default now() | |
| updated_at | timestamptz | NOT NULL, default now() | |
| version | bigint | NOT NULL, default 0 | Optimistic locking (CAS) for shared-mutable jsonb fields |

**Indexes**: UNIQUE (tenant_id, slug), idx_personas_tenant on (tenant_id)
**RLS**: USING (tenant_id = current_setting('app.current_tenant')::uuid)

### conversations

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | |
| tenant_id | uuid | NOT NULL, FK tenants(id) | |
| persona_id | uuid | NOT NULL, FK personas(id) ON DELETE CASCADE | |
| channel_id | uuid | nullable, FK channel_instances(id) | NULL for API-only chats |
| external_user_id | text | NOT NULL | Channel user ID or API caller identifier |
| summary | text | | Auto-generated summary after conversation ends |
| started_at | timestamptz | NOT NULL, default now() | |
| ended_at | timestamptz | | |
| message_count | integer | NOT NULL, default 0 | Denormalized counter |

**Indexes**: idx_conversations_tenant_persona on (tenant_id, persona_id), idx_conversations_tenant on (tenant_id)
**RLS**: USING (tenant_id = current_setting('app.current_tenant')::uuid)

### messages

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | |
| conversation_id | uuid | NOT NULL, FK conversations(id) ON DELETE CASCADE | |
| role | text | NOT NULL | 'user', 'assistant', 'system', 'tool' |
| content | text | NOT NULL | |
| metadata | jsonb | NOT NULL, default '{}' | {provider, model, input_tokens, output_tokens, latency_ms} |
| created_at | timestamptz | NOT NULL, default now() | |

**Indexes**: idx_messages_conversation on (conversation_id, created_at)
**RLS**: Inherited from conversation's tenant_id via EXISTS join

### channel_instances

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | |
| tenant_id | uuid | NOT NULL, FK tenants(id) | |
| persona_id | uuid | NOT NULL, FK personas(id) ON DELETE CASCADE | |
| channel_type | text | NOT NULL | 'telegram', 'whatsapp_evolution', ... |
| config | jsonb | NOT NULL | Channel-specific config. Secrets encrypted at app layer. |
| status | text | NOT NULL, default 'disconnected' | 'active', 'degraded', 'disconnected', 'error' |
| last_health_check_at | timestamptz | | |
| created_at | timestamptz | NOT NULL, default now() | |

**Indexes**: idx_channels_tenant on (tenant_id), idx_channels_tenant_persona on (tenant_id, persona_id)
**RLS**: USING (tenant_id = current_setting('app.current_tenant')::uuid)

### training_jobs

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | |
| tenant_id | uuid | NOT NULL, FK tenants(id) | |
| persona_id | uuid | NOT NULL, FK personas(id) | |
| source_type | text | NOT NULL | 'telegram_json', 'whatsapp_txt', 'generic_jsonl' |
| source_file_ref | text | NOT NULL | Path/URL to uploaded file |
| status | text | NOT NULL, default 'pending' | 'pending', 'running', 'completed', 'failed' |
| progress_percent | integer | NOT NULL, default 0 | 0-100 |
| extracted_traits | jsonb | | Populated on completion |
| error_message | text | | Populated on failure |
| started_at | timestamptz | | |
| completed_at | timestamptz | | |
| created_at | timestamptz | NOT NULL, default now() | |

**Indexes**: idx_training_tenant_persona on (tenant_id, persona_id), idx_training_status on (status) WHERE status IN ('pending', 'running')
**RLS**: USING (tenant_id = current_setting('app.current_tenant')::uuid)

### usage_events

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | |
| tenant_id | uuid | NOT NULL, FK tenants(id) | |
| persona_id | uuid | NOT NULL | |
| conversation_id | uuid | NOT NULL | |
| provider | text | NOT NULL | LLM provider name |
| model | text | NOT NULL | LLM model name |
| input_tokens | integer | NOT NULL | |
| output_tokens | integer | NOT NULL | |
| latency_ms | integer | NOT NULL | |
| created_at | timestamptz | NOT NULL, default now() | |

**Indexes**: idx_usage_tenant_created on (tenant_id, created_at), idx_usage_tenant_persona on (tenant_id, persona_id, created_at)
**RLS**: USING (tenant_id = current_setting('app.current_tenant')::uuid)
**Partitioning**: Partition by RANGE(created_at) monthly via pg_partman.

## Drizzle ORM Schema Snippets

### personas

```typescript
import { pgTable, uuid, text, jsonb, timestamp, bigint, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const personas = pgTable('personas', {
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
}, (table) => ({
  tenantSlugUnique: uniqueIndex('personas_tenant_slug_unique').on(table.tenantId, table.slug),
  tenantIdx: index('idx_personas_tenant').on(table.tenantId),
}));
```

### conversations

```typescript
import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  personaId: uuid('persona_id').notNull(),
  channelId: uuid('channel_id'),
  externalUserId: text('external_user_id').notNull(),
  summary: text('summary'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  messageCount: integer('message_count').notNull().default(0),
}, (table) => ({
  tenantPersonaIdx: index('idx_conversations_tenant_persona').on(table.tenantId, table.personaId),
  tenantIdx: index('idx_conversations_tenant').on(table.tenantId),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  persona: one(personas, {
    fields: [conversations.personaId],
    references: [personas.id],
  }),
  channel: one(channelInstances, {
    fields: [conversations.channelId],
    references: [channelInstances.id],
  }),
  messages: many(messages),
}));
```

### messages

```typescript
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  conversationId: uuid('conversation_id').notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata').notNull().$type<MessageMetadata>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  conversationIdx: index('idx_messages_conversation').on(table.conversationId, table.createdAt),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));
```

## RLS Policies

Multi-tenant isolation uses PostgreSQL Row-Level Security as defense-in-depth:

1. **Application-layer filtering**: Every query includes `WHERE tenant_id = :currentTenantId`.
2. **Connection-level tenant context**: `SET app.current_tenant = '<tenant_id>'` per request.
3. **RLS policy template**:
   ```sql
   ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON <table>
     USING (tenant_id = current_setting('app.current_tenant')::uuid);
   ```
   **CRITICAL**: `SET LOCAL app.current_tenant = '<id>'` MUST be used inside a transaction (not bare `SET`). `SET LOCAL` scopes the variable to the current transaction only — it resets automatically on commit/rollback, preventing cross-tenant leakage via pooled connections. Every tenant-scoped repository call MUST run inside `db.transaction(async (tx) => { await tx.execute(sql\`SET LOCAL app.current_tenant = '${tenantId}'\`); ... })`.

4. **messages table**: RLS via EXISTS join on parent conversation:
   ```sql
   ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation_messages ON messages
     USING (
       EXISTS (
         SELECT 1 FROM conversations
         WHERE conversations.id = messages.conversation_id
           AND conversations.tenant_id = current_setting('app.current_tenant')::uuid
       )
     );
   ```
5. **pgbouncer compatibility**: When using pgbouncer in transaction-pooling mode, `SET LOCAL` works correctly inside transactions. Session-pooling mode also works. Do NOT use bare `SET` (without `LOCAL`) — it persists across transactions and leaks tenant context through pooled connections.

## Deferred: v2 Data Architecture

- **messages table partitioning**: Apply `pg_partman` monthly partitioning on `messages.created_at` (same pattern as `usage_events`). Deferred to v2 — v1 ships with unpartitioned `messages` table. Add retention policy (archive messages older than N days) when partitioning is implemented.

## Migration Strategy

- **Tool**: `drizzle-kit`
- **Generate**: `drizzle-kit generate` → SQL migration files
- **Apply**: `drizzle-kit migrate`
- **Storage**: `drizzle/` directory at repo root
- **CI/CD**: Migrations as explicit deployment step — no runtime auto-migration in production
- **Rollback**: Manual `.sql` files in `drizzle/rollbacks/` or PITR from Postgres backups
