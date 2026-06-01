# Implementation Plan: Re-engagement Runtime

**Branch**: `009-reengagement-runtime` | **Date**: 2026-06-01 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/009-reengagement-runtime/spec.md`

## Summary
Implement a high-frequency scanner and worker in the Engine to re-engage dormant conversations. **BullMQ runs the periodic scan only** (a repeatable cron job); per-attempt processing is **DB-status-claim** (atomic `scheduled → processing`, no per-attempt queue job). ChatService/LLM generate the hook; **Redis Streams (`REDIS_STREAMS.OUTBOUND`)** hand off delivery to the channel adapters (same transport as 006).

## Technical Context
**Language/Version**: TypeScript (Node.js >= 20)
**Primary Dependencies**: BullMQ (scan cron only), Drizzle ORM, IORedis, ChatService (internal)
**Storage**: PostgreSQL (via Drizzle ORM); Redis (BullMQ scan queue + `OUTBOUND` stream)
**Testing**: Vitest
**Target Platform**: Engine Worker (Node.js)
**Project Type**: pnpm workspace
**Performance Goals**: < 2s schedule→delivery (SC-002), 10k conversations/run (SC-004)
**Constraints**: Multi-tenant isolation (SC-003); idempotency via `UNIQUE(idempotencyKey)` + atomic `scheduled→processing` status claim (FR-009); stuck-processing recovery via timeout sweep (FR-011, `TWIN_REENGAGE_CLAIM_TIMEOUT_MS`); LLM call timeout (`TWIN_REENGAGE_LLM_TIMEOUT_MS`, default 30 s); DD-RE-001 boundary rules.

## Concurrency & Recovery (hermes H4 / C1, antigravity F1)

- **Worker concurrency**: the DB-status-claim worker scales horizontally — run **N worker processes** (`TWIN_REENGAGE_WORKERS`, default 4, tunable), each atomically claiming one `scheduled` attempt at a time (`UPDATE ... WHERE status='scheduled' ... RETURNING`). No shared lock — the atomic claim IS the concurrency guard. **SC-002 (p95 < 2 s) is per claimed attempt**, not whole-batch drain; a 10k backlog is drained by N workers in parallel, N sized to the scan interval.
- **Stuck recovery**: a periodic sweep (≈ every 60 s) moves `processing` rows with `claimedAt + TWIN_REENGAGE_CLAIM_TIMEOUT_MS < now()` → `failed('worker_timeout')` (FR-011). With the per-call LLM timeout, no attempt is stuck forever. Chosen over BullMQ-per-attempt (antigravity's alt) to stay consistent with the DB-claim architecture; the sweep is lighter than a second queue.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] Principle I: Source of Truth Discipline (No hand-editing generated files)
- [x] Principle VI: Cross-AI Review Gate (Will require 2 reviewers before implement)
- [x] Principle VII: Artifact Versioning (Snapshot tags used)
- [x] No naming by LLM model
- [x] Multi-tenant scoping enforced
- [x] Idempotency via `UNIQUE(idempotencyKey)` constraint + atomic status claim (not check-then-insert)
- [x] Standing Order 5: migrations generated as reviewed `.sql` (T007), not auto-applied

## Project Structure

### Documentation (this feature)

```text
specs/009-reengagement-runtime/
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
│   └── src/types/reengagement.ts
├── core/
│   ├── src/models/followups.ts
│   └── src/services/reengagement/
│       ├── scanner.ts          # dormancy scan → schedule attempts (scanner.contract.md)
│       ├── generator.ts        # LLM hook generation (hook-generator.contract.md)
│       ├── delivery.ts         # hand-off to REDIS_STREAMS.OUTBOUND (delivery.contract.md)
│       └── worker.ts           # DB-status-claim worker: scheduled→processing→sent
└── api/
    └── tests/integration/reengagement/
```

**Structure Decision**: All runtime logic in `packages/core/src/services/reengagement/` (scanner, generator, delivery, worker). Shared types in `packages/shared`. Drizzle models in `packages/core/src/models/followups.ts`. BullMQ wires only the repeatable scan; attempt processing is DB-status-claim.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Cross-repo migration dependency | DD-RE-001 requires shared ownership | Splitting tables would break Product-side reporting |
