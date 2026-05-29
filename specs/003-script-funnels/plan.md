# Implementation Plan: Script Funnels — Dialog Funnel Runtime

**Branch**: `003-script-funnels` | **Date**: 2026-05-29 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/003-script-funnels/spec.md`

## Summary

Port legacy Script Funnels engine (dialog funnel runtime) into the engine. Deterministic fragment scorer with Russian stemmer, stage controller, async slot verification, and funnel ingestion endpoint.

## Technical Context

**Language/Version**: TypeScript (Node.js >= 20)
**Primary Dependencies**: Fastify, Drizzle ORM, Zod, Redis (ioredis), `natural` (for stemming)
**Storage**: PostgreSQL (via Drizzle ORM)
**Testing**: Vitest
**Target Platform**: Node.js backend
**Project Type**: Monorepo packages (core, api, shared)
**Performance Goals**: <100ms match time on hot path
**Constraints**: Multi-tenant isolation mandatory (tenant_id scoping), optimistic locking for concurrency

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] Avoid naming by LLM model
- [x] Operator identity from JWT (via tenant middleware)
- [x] Optimistic locking (versioning) used for funnel state updates
- [x] No LLM call at match time blocking the response
- [x] Fastify routes validate input via Zod
- [x] Principle V: File count proportional to feature scope (6 tables for 6 entities, 1 route file mirroring existing pattern)
- [x] Principle VII: Each pipeline stage tagged via snapshot-stage script

## Project Structure

### Documentation (this feature)

```text
specs/003-script-funnels/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
packages/
├── shared/
│   └── src/types/
├── core/
│   ├── src/models/
│   └── src/services/funnel/
└── api/
    ├── src/routes/
    └── tests/integration/
```

**Structure Decision**: Add funnel runtime and scoring into `packages/core/src/services/funnel/`. Add ingestion routes to `packages/api/src/routes/funnels.ts`.

## Complexity Tracking

None at this time.