# Implementation Plan: Fact Grounding (RAG Runtime)

**Branch**: `005-fact-grounding` | **Date**: 2026-05-30 | **Spec**: [spec.md](file:///C:/Repositories/underundre/underhelpers/under-ai-helpers/undrecreaitwins/specs/005-fact-grounding/spec.md)
**Input**: Feature specification from `specs/005-fact-grounding/spec.md`

## Summary

005 is a RETRIEVAL layer over the shared `008-agent-builder` substrate (pgvector + TEI embedding-service: BGE-M3 + BGE-reranker-v2-m3). It does NOT build its own ingest pipeline: ingestion delegates to 008's document-service (async BullMQ); 005 owns vector+reranker retrieval and LLM context formatting. Hybrid full-text search is deferred (spec §11).

## Technical Context

**Language/Version**: TypeScript, Node.js
**Primary Dependencies**: `pgvector` (via Drizzle ORM); shared 008 embedding-service (TEI: BGE-M3 + BGE-reranker-v2-m3). Ingest delegates to 008 `document-service` — 005 ships no parser of its own.
**Storage**: PostgreSQL (pgvector)
**Testing**: Jest / Vitest
**Target Platform**: Node.js backend (`packages/core`)
**Project Type**: Backend library / Core engine module
**Constraints**: Shares pgvector + embedding-service with 008. No Qdrant. BLOCKED on 008 substrate (T002/T004/T006/T007/T008; T020 for ingest) — see tasks.md Phase 0. Vector+reranker only; hybrid FTS deferred (spec §11). All DB access via `withTenantContext(tenantId, ...)`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle VIII (Self-Maintaining Knowledge)**: The architectural decision to drop Qdrant in favor of pgvector (aligned with 008) is reflected here, preventing infrastructure drift and duplicate RAG stacks.
- **Principle VI**: Review gate will be required before implementation.

## Project Structure

### Documentation (this feature)

```text
specs/005-fact-grounding/
├── plan.md              # This file (/speckit.plan command output)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   └── IGroundingEngine.ts
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
packages/core/
├── src/
│   ├── services/
│   │   ├── grounding/
│   │   │   ├── GroundingEngine.ts      # wires retrieval + ingest adapter
│   │   │   ├── retrieval.ts            # vector (HNSW cosine) + BGE-reranker-v2-m3
│   │   │   └── ingest-adapter.ts       # delegates to 008 document-service (BullMQ)
│   └── interfaces/
│       └── IGroundingEngine.ts
└── tests/
    └── integration/
        └── grounding/
            └── GroundingEngine.test.ts
```

**Structure Decision**: The implementation lives within `packages/core` under a new `grounding` service module. It orchestrates RETRIEVAL (vector + rerank via the shared embedding-service) and delegates INGEST to 008's document-service. No parsing / embedding / storage is reimplemented here — that is owned by the 008 substrate.
