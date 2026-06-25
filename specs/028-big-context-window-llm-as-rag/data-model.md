# Data Model: 028 — Big Context Window LLM as RAG

This document outlines the schema migrations required for the database substrate.

## Schema Modifications

### 1. `tenants` Table

Add a tenant-level default grounding mode.

```typescript
// packages/core/src/models/tenants.ts
import { text } from 'drizzle-orm/pg-core';

// Inside tenants table definition:
groundingMode: text('grounding_mode').notNull().default('vector').$type<'vector' | 'big-context'>()
```

### 2. `personas` Table

Add persona-level overrides for grounding mode, truncation strategy, and manual token budget limits.

```typescript
// packages/core/src/models/personas.ts
import { text, integer } from 'drizzle-orm/pg-core';

// Inside personas table definition:
groundingMode: text('grounding_mode').$type<'vector' | 'big-context'>(), // nullable override
bigContextMaxTokens: integer('big_context_max_tokens'), // nullable manual override
truncationStrategy: text('truncation_strategy').notNull().default('silent').$type<'silent' | 'fallback-vector'>(),
// Tracks readiness of lazy embeddings for fallback-vector. Driven by lazy-embed-worker.
// 'idle' = no indexing needed/started, 'processing' = job running, 'completed' = ready for fallback.
embeddingsStatus: text('embeddings_status').notNull().default('idle').$type<'idle' | 'processing' | 'completed'>()
```

> **Note**: `embeddingsStatus` is what the `'fallback-vector'` strategy gates on (FR-006). The `lazy-embed-worker` flips it `idle → processing → completed` around its job lifecycle. A persona with `embeddingsStatus !== 'completed'` MUST degrade to `'silent'` truncation, never fall through to a partial vector index.

### 3. `documents` Table

Add columns for storing the full plain-text extraction of the uploaded file, plus priority for intelligent truncation.

```typescript
// packages/core/src/models/documents.ts
import { text, integer } from 'drizzle-orm/pg-core';

// Inside documents table definition:
fullText: text('full_text'), // Nullable (null for unsupported / non-extracted types, or when not ready)
priority: integer('priority').notNull().default(0) // Default 0 priority, higher survives truncation
```

---

## SQL Migration Script

The following SQL commands will be generated for review (and never auto-applied).

```sql
-- Up Migration
ALTER TABLE tenants ADD COLUMN grounding_mode TEXT NOT NULL DEFAULT 'vector';
ALTER TABLE personas ADD COLUMN grounding_mode TEXT;
ALTER TABLE personas ADD COLUMN big_context_max_tokens INTEGER;
ALTER TABLE personas ADD COLUMN truncation_strategy TEXT NOT NULL DEFAULT 'silent';
ALTER TABLE personas ADD COLUMN embeddings_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE documents ADD COLUMN full_text TEXT;
ALTER TABLE documents ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

-- documents → document_chunks already cascades: the Drizzle schema declares
--   documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' })
-- (models/documents.ts:30-32). NO migration ALTER is needed for CASCADE — adding a
-- DROP CONSTRAINT ... ADD CONSTRAINT ... ON DELETE CASCADE here would be redundant
-- at best, and at worst would create a duplicate FK if Drizzle named the constraint
-- differently than `document_chunks_document_id_fkey`. The orphan-chunks sweep worker
-- (T023) is retained ONLY as a safety net for manual-SQL / partial-fail deletions
-- that bypass the ORM-driven cascade.

-- Optimize PostgreSQL storage compression for fullText.
-- lz4 compression requires PG 14+. The migration MUST guard on server version
-- and emit a NOTICE + skip the lz4 ALTER on older servers rather than aborting
-- the whole migration. NOTE: compare numerically against the full version_num
-- (e.g. 140000 for PG 14.0), NOT a substring — `substring(... for 2)` returns
-- "90" for PG 9.x which casts to 90 >= 14 and wrongly runs the lz4 ALTER on
-- the very servers the guard is meant to protect.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 140000 THEN
    ALTER TABLE documents ALTER COLUMN full_text SET COMPRESSION lz4;
  ELSE
    RAISE NOTICE 'PG < 14 (%); skipping lz4 compression for full_text.', current_setting('server_version');
  END IF;
END $$;

-- Down Migration (Rollback)
ALTER TABLE tenants DROP COLUMN grounding_mode;
ALTER TABLE personas DROP COLUMN grounding_mode;
ALTER TABLE personas DROP COLUMN big_context_max_tokens;
ALTER TABLE personas DROP COLUMN truncation_strategy;
ALTER TABLE personas DROP COLUMN embeddings_status;
ALTER TABLE documents DROP COLUMN full_text;
ALTER TABLE documents DROP COLUMN priority;
```
