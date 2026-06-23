# Implementation Plan: Validators ⊕ Quality Rules — Unified Response Guard Pipeline

**Branch**: `027-validators-quality-convergence` | **Date**: 2026-06-23 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `spec.md`

## Summary

Merge two independent post-processing pipelines (`ValidatorPipeline.validateResponse()` + `darExecute()`) into a single tiered `responseGuard.run()` orchestration module. System validators become built-in default quality rules (non-removable, configurable). Unified run-log emits `QualityEventPush` to existing engine→BFF channel. Preserves cost model (deterministic checks first, LLM only on violation) and behavior parity with 004/017/018/024.

## Technical Context

**Language/Version**: TypeScript (Node.js, engine runtime)
**Primary Dependencies**: Existing engine packages (`packages/core`), Drizzle ORM (engine), Prisma (BFF), LLM provider abstraction (018)
**Storage**: Engine Postgres (Drizzle) for rule-cache + internal logs; BFF Postgres (Prisma) for unified `QualityEvent` table; cross-service via `QualityEventPush` channel
**Testing**: Vitest (unit + integration), regression suites from 004/017/018/024
**Target Platform**: Node.js engine service + BFF API
**Project Type**: library (engine core) + service integration
**Performance Goals**: p95 latency ≤ max(current validateResponse, darExecute); happy-path LLM call count = 0 for personas without custom rules
**Constraints**: Cost parity (NFR-1), behavior parity (NFR-3), backward compatibility (NFR-4)
**Scale/Scope**: 3 call-sites in chat-service (happy-path, buffered-delivery, agentic); 4 system validators; N custom rules per tenant

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Source of Truth Discipline | PASS | `.claude/` remains authoritative; engine types flow to BFF via push, not reverse |
| II. Transformer, Not Fork | PASS | No new AI-tool target; changes confined to engine + BFF services |
| III. Protected Slots | N/A | No managed instruction files edited |
| IV. SemVer Discipline | PASS | Breaking change to `ValidatorRun`/`QualityEvent` shape → MINOR bump (0.x semantics) |
| V. Token Economy | PASS | No new agents/skills; reuses existing validator classes |
| VI. Cross-AI Review Gate | PENDING | Requires `/speckit.analyze` + ≥2 external reviews before `/speckit.implement` |
| VII. Artifact Versioning | PASS | Will snapshot plan/tasks stages via `snapshot-stage.sh` |
| VIII. Self-Maintaining Knowledge | PASS | No new patterns; converges existing duplication |
| IX. Two-Phase Review Flow | PASS | Planning in `specs/027-*`; implementation on `027-*` branch from main |

**Gate Result**: PASS (VI deferred to implementation gate)

## Project Structure

### Documentation (this feature)

```text
specs/027-validators-quality-convergence/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0: NEEDS CLARIFICATION resolution
├── data-model.md        # Phase 1: unified rule + log models
├── quickstart.md        # Phase 1: integration guide
├── contracts/           # Phase 1: engine↔BFF contract updates
│   ├── quality-event-push.md
│   └── rules-reload.md
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
packages/core/src/
├── services/
│   ├── chat-service.ts                    # MODIFY: replace validateResponse + darExecute with responseGuard.run()
│   ├── validators/
│   │   ├── pipeline.ts                    # REFACTOR: ValidatorPipeline → ResponseGuard (orchestrator)
│   │   ├── language-guard.ts              # REUSE: existing validator class
│   │   ├── false-promise.ts               # REUSE: existing validator class
│   │   ├── format-injection.ts            # REUSE: existing validator class
│   │   └── identity-guard.ts              # REUSE: existing validator class
│   ├── correction-rules/
│   │   ├── dar-pipeline.ts                # MODIFY: emit as stage in unified pipeline
│   │   ├── re-validator.ts                # REUSE: existing re-validation logic
│   │   └── response-guard.ts              # NEW: unified orchestration module
│   └── rule-cache/
│       └── index.ts                       # MODIFY: accept system+custom rules from BFF
├── models/
│   └── validators.ts                      # MODIFY: deprecate validator_runs, add QualityEventPush types
└── types/
    └── quality.ts                         # NEW: unified verdict/detail types

packages/bff/                              # ai-twins repo (separate)
├── src/
│   ├── services/
│   │   ├── correction-rules/
│   │   │   └── reload.ts                  # MODIFY: extend to push system+custom rules
│   │   └── quality-events/
│   │       └── push.ts                    # MODIFY: accept system events from engine
│   └── prisma/
│       └── schema.prisma                  # MODIFY: unified QualityEvent table (backfill .sql)
└── prisma/
    └── migrations/                       # GENERATED: .sql on review (Standing Order 5)
```

**Structure Decision**: Build-on path B (refactor `ValidatorPipeline` into `ResponseGuard` orchestrator, DAR becomes a stage). No fork, no rewrite of chat-service.

## Complexity Tracking

> No constitution violations requiring justification.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | — | — |
