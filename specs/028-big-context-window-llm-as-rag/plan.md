# Implementation Plan: 028 — Big Context Window LLM as RAG

**Branch**: `spec/028-big-context-window-llm-as-rag` | **Date**: 2026-06-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/028-big-context-window-llm-as-rag/spec.md`

## Summary

This feature replaces the existing vector-based RAG pipeline (chunking -> embedding -> pgvector similarity -> BGE-reranker) with a direct document injection approach for personas/tenants using large context window LLMs. Raw extracted document text will be stored as-is in PostgreSQL. On query, all persona-associated documents will be retrieved, sorted by priority and recency, and packed within the token budget of the configured LLM. Ingest, retrieval, prompt formatting, token counting, cost reporting, and fallback mechanisms are modified to support this new paradigm while preserving vector RAG as a tenant-wide and/or query-level fallback.

## Technical Context

- **Language/Version**: Node.js 20+, TypeScript 5.x, PostgreSQL 14+ (lz4 compression for `full_text` requires PG ≥ 14; the migration MUST guard on `server_version_num` and skip the lz4 ALTER with a NOTICE on older servers rather than aborting — F4)
- **Primary Dependencies**: Drizzle ORM, BullMQ, officeparser (mammoth, pdf-parse), js-tiktoken, Fastify
- **Storage**: PostgreSQL (pgvector plugin and `documents` schema updates, column compression `lz4`)
- **Testing**: Vitest (`npm test`)
- **Target Platform**: Docker-compose (Linux)
- **Project Type**: Monorepo with packages: `packages/core` (business logic, routing, db schema), `packages/training` (ingest worker), `packages/api` (REST endpoints)
- **Performance Goals**: 
  - TOAST decompression latency under 50ms for persona document sets using `lz4` compression.
  - LLM input token caching maximization via prefix-stable document blocks (ordered before the query).
  - Routine metadata query latency unaffected (0ms TOAST decompression overhead by omitting `fullText` column).
- **Constraints**: 
  - Token budget resolved dynamically with safety margin >= 5%.
  - Offline token count fallback via `js-tiktoken` (BPE tokenizer cl100k_base).
  - Strict tenant and persona isolation.
  - Log redaction: Document content must not be printed in logs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle I (Source of Truth)**: No generated files in `.claude/` are hand-edited. (PASS - this is codebase feature work, not CLI configuration sync).
- **Principle IV (SemVer)**: Non-breaking features bumping `packages/cli` require minor bump; however, this is a substrate/core engine feature. No version bump of CLI is required unless dependencies change.
- **Principle VI (Cross-AI Review)**: The implementation gate `/speckit.implement` requires `/speckit.analyze` PASS + 2 external reviewer PASSes. (PASS - we will generate plans and tasks to enable analysis and reviews).
- **Principle VII (Artifact Versioning)**: Snapshot stages must tag the repository (`plan/028-big-context-window-llm-as-rag/v1`). We will call `snapshot-stage.ps1` or `.sh`. (PASS - we will execute the tag snapshot).

## Project Structure

### Documentation (this feature)

```text
specs/028-big-context-window-llm-as-rag/
├── plan.md              # This file
├── research.md          # Complete research (already generated)
├── data-model.md        # Data model additions/modifications
├── quickstart.md        # Instructions to run/verify
├── contracts/           # API and payload contracts
└── tasks.md             # Task list with lane breakdown (Phase 2)
```

### Source Code

```text
packages/core/
├── src/
│   ├── models/
│   │   ├── documents.ts            # Drizzle columns documents.fullText, priority, and indexes. NOTE: document_chunks → documents FK already cascades (onDelete: 'cascade') — no migration change needed for CASCADE (F3)
│   │   └── personas.ts             # personas.groundingMode, bigContextMaxTokens, truncationStrategy, embeddingsStatus
│   │   └── tenants.ts              # tenants.groundingMode
│   ├── services/
│   │   ├── document-service.ts     # Ingest updates (trigger lazy embedding, background job check)
│   │   ├── grounding/
│   │   │   ├── retrieval.ts        # Big-context retrieve logic, truncation, token-count cascade (OmniRoute → js-tiktoken → chars/4)
│   │   │   └── GroundingEngine.ts  # Route query based on effective groundingMode; fallback-vector gates on embeddingsStatus === 'completed'
│   │   ├── tuning/
│   │   │   └── doc-extraction-pipeline.ts # Skip empty-query vector RAG; retrieve full documents
│   │   └── document-worker.ts      # Test worker updates (parse, fullText storage)
packages/training/
├── src/
│   └── jobs/
│       ├── document-ingest-worker.ts # Ingest worker updates (fullText extraction, mammoth/pdf-parse)
│       ├── lazy-embed-worker.ts    # Background lazy indexing worker for fallback-vector; drives embeddingsStatus lifecycle (idle → processing → completed)
│       └── orphan-chunks-sweep-worker.ts # Scheduled safety-net sweep for document_chunks rows whose parent document was hard-deleted (complements the CASCADE FK)
```

**Structure Decision**: Monorepo updates across core services, schema, and training queues to support direct text extraction, transactional database storage, and runtime context packaging.

## Complexity Tracking

No violations of the Constitution. Complexity is minimized by reusing the existing `GroundingContext` array wrapper to avoid downstream chat service breaking changes.
