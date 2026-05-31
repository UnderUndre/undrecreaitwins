# SpecKit Review: 005-fact-grounding

**Reviewer**: codex
**Reviewed at**: 2026-05-31T11:44:32.4612676Z
**Commit**: e99be83c36ace84dfd85b9d893c3ca7d3c8d5284
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/IGroundingEngine.ts, quickstart.md, reviews/context-for-review.md (empty), .specify/memory/constitution.md, specs/008-agent-builder/{spec.md,plan.md,tasks.md,data-model.md}

## Summary

The direction is right: 005 stopped trying to invent a second RAG stack and aligns with 008 on pgvector, BGE-M3, and TS parsing. The weak point is that the contract and task graph do not encode the hard invariants of that shared substrate: tenant-scoped RLS, async ingestion status, and the 008 setup barrier. As written, implementation can start against a pipe that is not installed yet, and `query()` has no tenant context to safely open it.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | CRITICAL | Security / tenancy | `IGroundingEngine.query(query, twinId)` has no `tenantId` (`contracts/IGroundingEngine.ts:20`, `spec.md:19`), and the quickstart repeats the tenant-less call (`quickstart.md:31`). The shared 008 tables are tenant-scoped and RLS-keyed on `app.current_tenant` (`008-agent-builder/data-model.md:3`, `008-agent-builder/data-model.md:86`), while the actual helper needs a tenant id to set that context (`packages/core/src/db.ts:18`). Implementation therefore either cannot satisfy RLS or must infer tenant from `twinId`, which is not specified and risks cross-tenant leakage or silent empty reads. | Change the query contract to accept explicit tenant context, for example `query(query, tenantId, twinId/personaId)`, or specify an authoritative request/auth context injection path. Add explicit tasks that all retrieval and ingest DB access uses `withTenantContext()`, and add a tenant-isolation integration test for document chunks. |
| F2 | HIGH | Cross-feature dependency | 005 says "No specific setup required" because pgvector and embeddings are established by 008 (`tasks.md:10`), but 008 marks pgvector, embedding-service, models, RLS, and HNSW as net-new tasks (`008-agent-builder/tasks.md:26`-`008-agent-builder/tasks.md:29`) with a substrate checkpoint only after those land (`008-agent-builder/tasks.md:32`). 005's dependency graph lets T001/T002/T003 start immediately (`tasks.md:22`-`tasks.md:24`), so implementers can build against missing schema and missing embedding service. | Add an explicit prerequisite/sync barrier in 005: 008 T002, T004, T006, T007, and T008 must be complete before 005 T001/T003/T005. Better: extract the shared RAG substrate into a named dependency section or separate feature so 005 and 008 do not race each other. |
| F3 | HIGH | Ingestion semantics | 005 exposes `ingest(...): Promise<void>` (`contracts/IGroundingEngine.ts:25`) and quickstart awaits it synchronously (`quickstart.md:23`), but 008's document model has async lifecycle states `pending`, `parsing`, `ready`, `failed` (`008-agent-builder/data-model.md:29`) and its document pipeline uses BullMQ (`008-agent-builder/plan.md:97`, `008-agent-builder/tasks.md:63`). This splits the same document ingestion path into sync facade vs async worker without defining who owns status, retries, cleanup, or partial embed failure. | Decide the contract. If ingestion is async, return `{ documentId, status }` or a job id, document `ready`-only retrieval, and add failure/status tests. If ingestion is sync, remove the dependency on 008's async worker and specify timeouts, backpressure, and rollback on partial chunk writes. |
| F4 | HIGH | Retrieval design | 005 requires hybrid "Full-text + Vector" search (`spec.md:29`, `tasks.md:22`), but the shared 008 data model only defines vector HNSW plus btree tenant/persona indexes for `document_chunks` (`008-agent-builder/data-model.md:48`). There is no `tsvector`/GIN index, language configuration, ranking blend formula, top-k limits, rerank threshold, or fallback behavior. T001 will force implementers to invent core search semantics in code. | Either add full-text schema/index work to the shared data model and migration tasks, or narrow 005 to vector + rerank. In either case, define top-k, context budget, rank blending, language/stemming behavior for Russian, and no-match thresholds before implementation. |
| F5 | MEDIUM | Domain model clarity | 005 uses `twinId` throughout the interface (`contracts/IGroundingEngine.ts:20`, `contracts/IGroundingEngine.ts:25`), while the shared 008 data model stores documents and chunks by `personaId` (`008-agent-builder/data-model.md:25`, `008-agent-builder/data-model.md:42`). The spec does not define whether twin, persona, and assistant are aliases or different entities. | Pick the canonical retrieval key or define a mapping. If `twinId` maps to `personaId`, document where that lookup happens and how tenant isolation applies during the lookup. |
| F6 | MEDIUM | Failure modes / limits | 005 inherits parser, embedding service, and pgvector dependencies but does not restate the operational limits or failure behavior. 008 has file limits (`008-agent-builder/data-model.md:28`, `008-agent-builder/tasks.md:62`) and an external TEI embedding sidecar (`008-agent-builder/tasks.md:20`, `008-agent-builder/tasks.md:27`); 005 does not say what `ingest()` or `query()` returns when parsing fails, embeddings time out, the DB is slow, a document is scanned/OCR-needed, or duplicate content is uploaded. | Import 008's limits explicitly into 005 and add error taxonomy: unsupported type, too large, parse failed, embedding unavailable, duplicate/idempotent ingest, DB timeout, and no-context result. |
| F7 | MEDIUM | Test coverage | T005 is a single integration test for "ingest a test PDF and retrieve relevant context" (`tasks.md:18`, `tasks.md:26`). That does not cover the risky parts of this feature: tenant isolation, empty query, unsupported MIME, max-size document, parser failure, embedding outage, partial chunk rollback, no-match threshold, or hybrid ranking correctness. | Expand T005 or split it into focused unit/integration tests for security, failure, and ranking. At minimum require tenant A cannot retrieve tenant B's chunks and embedding-service failure does not persist half-ingested documents. |

## Alternative approaches considered

1. Make 005 a thin facade over 008's document-service and embedding-service: 008 owns ingestion, schema, async status, and jobs; 005 owns only retrieval orchestration and LLM context formatting.
2. Split a shared `rag-substrate` stage out of 008, containing pgvector extension, document tables, RLS, HNSW/FTS indexes, parser, and embedding client. Then both 005 and 008 depend on that stage.
3. If hybrid search is mandatory, keep Postgres as the single store but add explicit generated `tsvector` columns/GIN indexes and a documented rank blend instead of adding a second vector/search service.

## VERDICT

```yaml
verdict: CRITICAL
reviewer: codex
reviewed_at: 2026-05-31T11:44:32.4612676Z
commit: e99be83c36ace84dfd85b9d893c3ca7d3c8d5284
critical_count: 1
high_count: 3
medium_count: 3
low_count: 0
```
