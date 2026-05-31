# Data Model: Fact Grounding (005)

**This feature does NOT introduce new tables.**

As per the specification (aligned with the 008-agent-builder substrate), Fact Grounding shares the vector storage substrate with the Agent Builder feature.
All data modeling for documents, document chunks, and embeddings is defined and managed in `008-agent-builder/data-model.md`.

- **Vector Storage**: `pgvector` extension in PostgreSQL
- **Tables used**: `documents`, `document_chunks` (defined in 008)
- **Embedding Dimension**: 1024 (BGE-M3)

## Retrieval access (005-specific)

- **Tenant isolation**: every read/write goes through `withTenantContext(tenantId, fn)` (`packages/core/src/db.ts`), which runs `SET LOCAL app.current_tenant = <tenantId>`. 008 RLS policy: `USING (tenant_id = current_setting('app.current_tenant')::uuid)`. No tenant context ⇒ no rows.
- **Retrieval filter**: `document_chunks` filtered by `tenantId` (RLS) + `personaId` (= `twinId`; a denormalized column in 008 added for exactly this filter).
- **Status gate**: only chunks of documents with `status === 'ready'` are retrievable (`pending` / `parsing` / `failed` excluded).
- **Search**: HNSW cosine (vector) → BGE-reranker-v2-m3 rerank. There is **no** full-text / `tsvector` / GIN index in the shared substrate (hybrid deferred — spec §11).
- **Indexes reused (defined in 008, not added by 005)**: `HNSW (embedding vector_cosine_ops)` + `btree (tenantId, personaId)`.
- **Ingestion writes**: owned by the 008 document-service (BullMQ worker T020); 005 does not write `documents` / `document_chunks` directly.
