# Fact Grounding Quickstart

This guide explains how to use the `IGroundingEngine` service — a retrieval layer over the shared `008-agent-builder` substrate.

## Initialization

The Grounding Engine is injected as part of the core engine services. It relies on the shared `embedding-service` (TEI: BGE-M3 + BGE-reranker-v2-m3) and PostgreSQL (`pgvector`). All DB access is tenant-scoped via `withTenantContext`.

## Ingesting a Document (async)

Ingestion is delegated to the shared 008 document-service (BullMQ pipeline) and is **asynchronous** — it returns immediately with a status; the document becomes retrievable only after `status === 'ready'`.

```typescript
import fs from 'fs/promises';

const docBuffer = await fs.readFile('./company_policies.pdf');
const meta = {
  filename: 'company_policies.pdf',
  mimeType: 'application/pdf', // pdf / docx / txt only, ≤ 10 MB
  sizeBytes: docBuffer.byteLength,
};

const { documentId, status } = await engine.grounding.ingest(
  docBuffer,
  meta,
  tenantId,
  twinId,
);
// status: 'pending' | 'parsing' | 'ready' | 'failed'
// Poll / subscribe until 'ready' before expecting retrieval hits.
```

## Querying Context

`query` requires `tenantId` (opens RLS) and `twinId` (maps to personaId). It returns `[]` when nothing passes the rerank threshold.

```typescript
const context = await engine.grounding.query(
  'What is our refund policy?',
  tenantId,
  twinId,
);

if (context.length > 0) {
  const contextStr = context.map((c) => c.text).join('\n\n');
  // Inject contextStr into the LLM prompt.
} else {
  // No grounded context — proceed without it, or signal low confidence.
}
```

## Notes

- Search is **vector + reranker** (BGE-reranker-v2-m3). Hybrid full-text is deferred (spec §11).
- Russian is handled natively by multilingual BGE-M3 — no extra config.
- Defaults (tunable): `vectorTopK=20`, `rerankTopN=5`, `minRerankScore=0.3`, `contextBudgetTokens≈2000`.
- Only documents with `status === 'ready'` are retrievable.
