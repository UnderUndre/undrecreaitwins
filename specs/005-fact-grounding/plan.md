# Implementation Plan: Fact Grounding (RAG Runtime)

**Branch**: `005-fact-grounding` | **Date**: 2026-05-30 | **Spec**: [spec.md](file:///C:/Repositories/underundre/underhelpers/under-ai-helpers/undrecreaitwins/specs/005-fact-grounding/spec.md)
**Input**: Feature specification from `specs/005-fact-grounding/spec.md`

## Summary

Implementation of the RAG-module (Retrieval-Augmented Generation) at the Engine level (`undrecreaitwins`) to support LLM factual accuracy. It integrates with pgvector and parses complex documents using TS-native libraries. It shares the pgvector substrate and BGE-M3 embedding services with the `008-agent-builder` feature to avoid duplication.

## Technical Context

**Language/Version**: TypeScript, Node.js
**Primary Dependencies**: `pgvector` (via Drizzle ORM), `officeParser`
**Storage**: PostgreSQL (pgvector)
**Testing**: Jest / Vitest
**Target Platform**: Node.js backend (`packages/core`)
**Project Type**: Backend library / Core engine module
**Constraints**: Must share pgvector and embedding-service with 008. No Qdrant.

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
│   │   │   ├── GroundingEngine.ts
│   │   │   ├── parsers.ts
│   │   │   └── hybrid-search.ts
│   └── interfaces/
│       └── IGroundingEngine.ts
└── tests/
    └── integration/
        └── grounding/
            └── GroundingEngine.test.ts
```

**Structure Decision**: The implementation will live entirely within `packages/core`, specifically under a new `grounding` service module that orchestrates parsing, embedding generation (calling the shared embedding-service), and vector storage.
