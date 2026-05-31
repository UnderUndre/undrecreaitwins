# Data Model: Agent Builder & Feedback Loop (008)

All tables tenant-scoped. Tenant isolation via Postgres **RLS** keyed on `app.current_tenant` (set by `withTenantContext`). New Drizzle models re-exported in `models/index.ts` + relations in `relations.ts` → `drizzle-kit generate`. **No `migrate` script** — apply via `drizzle-kit` CLI; the pgvector extension + RLS policies + HNSW indexes go in a hand-written migration reviewed as `.sql` (Standing Order 5).

**Embedding dimension**: BGE-M3 = **1024** → `vector(1024)`. Distance: cosine (`vector_cosine_ops`).

---

## 1. `personas` — EXTEND (the "Assistant")

Existing: `id, tenantId, name, slug, systemPrompt, traits(jsonb), modelPreferences(jsonb), version`. Add:

| Column | Type | Notes |
|--------|------|-------|
| `annotationSimilarityThreshold` | `real` | default **0.70**; tunable without redeploy (FR-014). |
| `hasAnnotations` | `boolean` | default **false**; toggled `true` on first annotation upsert, re-evaluated on delete. Hot-path guard (gemini F2) — reply path skips embed/retrieve when `false`. |

No new table — the wizard writes the existing persona fields (FR-006) + this column.

## 2. `documents` — NEW

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `tenantId` | uuid | RLS key |
| `personaId` | uuid FK → personas.id | cascade delete |
| `filename` | text | |
| `mimeType` | text | enum-checked: pdf / docx / txt only (FR-007) |
| `sizeBytes` | integer | ≤ 10 MB enforced at API + check |
| `status` | text | `pending` \| `parsing` \| `ready` \| `failed` |
| `error` | text null | parse failure reason |
| `createdAt` | timestamptz | |

Constraints: ≤ 10 files per persona (enforced in service). Index: `(tenantId, personaId)`.

## 3. `document_chunks` — NEW (vector)

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `tenantId` | uuid | RLS key |
| `documentId` | uuid FK → documents.id | cascade delete |
| `personaId` | uuid | denormalized for retrieval filter |
| `chunkIndex` | integer | order within doc |
| `text` | text | chunk content |
| `embedding` | `vector(1024)` | BGE-M3 |
| `createdAt` | timestamptz | |

Indexes: **HNSW** `(embedding vector_cosine_ops)`; btree `(tenantId, personaId)`. Retrieval = doc-RAG (KB context).

## 4. `annotations` — NEW (vector) — the few-shot moat

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `tenantId` | uuid | RLS key |
| `personaId` | uuid FK → personas.id | cascade delete |
| `originalQuery` | text | raw operator-flagged question |
| `normalizedQuery` | text | lowercase + trim + collapse-whitespace (FR-001) |
| `badResponse` | text | the flagged reply |
| `correctedResponse` | text | operator's correction (the few-shot answer) |
| `embedding` | `vector(1024)` | of `normalizedQuery` (BGE-M3) |
| `langfuseDatasetItemId` | text null | one-way sync ref (FR-012) |
| `createdAt` / `updatedAt` | timestamptz | |

Constraints: **UNIQUE `(tenantId, personaId, normalizedQuery)`** → normalized upsert (newest wins, FR-001). Indexes: **HNSW** `(embedding vector_cosine_ops)`; btree `(tenantId, personaId)`.

Retrieval (FR-003): embed incoming query → pgvector cosine top-k over `annotations` (filtered by persona, isolated from `document_chunks`) → rerank (BGE-reranker) → keep matches ≥ `annotationSimilarityThreshold` → inject top ≤3 as a few-shot block.

## 5. Langfuse (external, no engine table)

Traces/scores/datasets live **in Langfuse** (FR-011/012). The engine stores only the one-way ref (`annotations.langfuseDatasetItemId`). No engine-side analytics tables — adopted, not rebuilt.

---

## Relations

```
personas 1───N documents 1───N document_chunks
personas 1───N annotations
```

## RLS (all new tables)

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t>
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
```
Mirrors `drizzle/rls/001_enable_rls.sql`. Verified by a tenant-isolation integration test (no cross-tenant read of assistants/annotations/documents — SC-008).

## Migration order (one reviewed `.sql`)

1. `CREATE EXTENSION IF NOT EXISTS vector;`
2. `ALTER TABLE personas ADD COLUMN annotation_similarity_threshold real NOT NULL DEFAULT 0.70, ADD COLUMN has_annotations boolean NOT NULL DEFAULT false;`
3. `CREATE TABLE documents …; document_chunks …; annotations …;`
4. HNSW indexes on the two `embedding` columns.
5. RLS enable + policies on the three new tables.
