# Implementation Plan: Response & Input Validators (Phase 1)

**Branch**: `004-validators` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-validators/spec.md`

## Summary

Port the legacy validator subsystem into the engine as a composable pipeline that inspects outbound replies and inbound messages, remediating unsafe content before delivery. This phase implements the `false-promise`, `format-injection`, and `identity-and-provider-guard` validators, adding per-tenant/persona configuration (`active` vs `dry-run`) and database persistence for audit logs.

## Technical Context

**Language/Version**: TypeScript (Node.js)
**Primary Dependencies**: Drizzle ORM, Zod, existing LLM client (to be extracted/shared)
**Storage**: PostgreSQL
**Testing**: Vitest (Unit & Integration)
**Target Platform**: Node server — `packages/core` only in Phase 1 (no `packages/api` surface; validator config is seeded via SQL/migration, see spec Out of Scope)
**Project Type**: Web service / Core library
**Performance Goals**: <10ms added p95 latency for clean inputs/replies; max 1500ms when LLM judge invoked.
**Constraints**: Must compose cleanly with `003-script-funnels` generation hooks; no blocking the chat path indefinitely on failures.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Source of Truth | PASS | App-code feature (`packages/core`, `packages/api`); no `.claude/` or generated-file edits |
| II. Transformer, Not Fork | N/A | No AI-tool target changes |
| III. Protected Slots | N/A | No managed/generated files touched |
| IV. SemVer 0.x | N/A | No package version bump in this branch |
| V. Token Economy | PASS | No new agents/skills/commands; shared LLM client extracted **once** (reused by 003) — complexity justified |
| VI. Cross-AI Review Gate | PENDING | `analyze.md` + ≥2 external reviews required before `/speckit.implement`. `claude.md` + `trae-solo.md` written; this revision addresses their findings — re-review needed |
| VII. Artifact Versioning | PASS | `plan/tasks/review /004-validators/v1` tags exist at the base commit; new stage tags created on next commit |
| VIII. Self-Maintaining | PASS | Validator-port pattern is a `/learn` candidate post-ship |
| WRAP atomicity | PASS | T007 split into <500 LOC tasks (T007a/b/c); feature XOR refactor honored |

**Gate**: PASS on design principles. VI/VII are process gates handled at review/commit time, not design blockers.

## Project Structure

### Documentation (this feature)

```text
specs/004-validators/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Interfaces and types
│   └── validator.ts
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
packages/core/src/
├── db.ts                # Drizzle schema (adding configs and runs)
├── services/
│   ├── chat-service.ts  # Generates hook points
│   ├── llm-client.ts    # Extracted shared LLM client
│   └── validators/
│       ├── pipeline.ts               # Orchestrator
│       ├── false-promise.ts          # False promise validator
│       ├── format-injection.ts       # Format injection strip
│       └── identity-and-provider-guard.ts  # Identity & provider guard
└── types/
    └── validator.ts     # Internal DTOs and types
```

**Structure Decision**: The validator logic belongs in `packages/core/src/services/validators`. The shared LLM client extraction will live at `packages/core/src/services/llm-client.ts` to be shared between this feature and `003-script-funnels`. Database additions go into the existing Drizzle definitions in `packages/core/src/db.ts`. `identity-and-provider-guard` will be implemented as a deterministic regex-based validator.

## Design Decisions

### DD-001: Shared LLM client (with 003-script-funnels)
**Decision**: Extract a single `packages/core/src/services/llm-client.ts` consumed by both the false-promise judge and 003's slot verification. **Rationale**: both features need an async LLM seam off the chat hot path; two extractions would drift (Principle V). **Judge model**: `VALIDATOR_JUDGE_MODEL`, cheaper/faster than generation (FR-004). **Forward-looking (Phase 2 batching)**: the interface SHOULD accept a *batch* of `{ systemPrompt, userPrompt }` payloads sharing a model and return a batch of responses. Phase 1 sends batches of size 1 (only false-promise uses the judge); Phase 2 fact-grounding may batch multiple validators into one call (legacy `executeUnifiedValidation`). Design the interface now, implement batching when the second LLM validator lands — avoids the exact client-interface drift DD-001 exists to prevent.

### DD-002: Single post-generation hook + validator execution order
**Decision**: One shared post-generation hook in `chat-service.ts`, wired **once** and consumed by both 004-validators and 003-script-funnels via a coordinated change (FR-017) — never re-wired independently. Within the response stage, validators run **BLOCKING-first, REWRITE-last** so a total-rewrite (identity-guard) sees and does not discard an earlier disclaimer-append (false-promise). **Rationale**: prevents the silent-mutation-loss and hook-collision race surfaced in review (claude F3, trae F5).

### DD-003: Identity-guard defaults to dry-run when unconfigured
**Decision**: Per FR-015 (revised post-review), identity-and-provider-guard defaults to `dry-run` until a persona has a `fallbackMessage`; false-promise and format-injection default to `active`. **Rationale**: identity-guard's remediation is a total rewrite with a system default that can't match every persona's language/name — active-by-default would break character on deploy day (claude F1, CRITICAL). T017 migration enforces this for existing personas.

### DD-004: Failure isolation at two levels + empty-output guard
**Decision**: Wrap each validator (fail-policy on throw, verdict `error`) AND the orchestrator (deliver the original unmutated reply on pipeline-level failure); never deliver a mutation without a durable run row; substitute a safe fallback if remediation empties the reply (FR-016 / FR-019). **Rationale**: zero chat-path 5xx (SC-007) and no blank replies (SC-009).

### DD-005: Tenant isolation via RLS + withTenantContext
**Decision**: Both new tables get row-level-security policies keyed on `tenant_id`; all access routes through `withTenantContext()`. **Rationale**: a `tenant_id` column is not isolation (FR-021); SC-006 verified by T018.

## Source of Port

C:\Repositories\ai-digital-twins

Legacy validators ported from `server/services/validators/`: `identity-and-provider-guard.ts`, `response-validator.ts`, `validator-chain.ts`, plus the registry under `server/services/validators/registry/` (paths per `reviews/context-for-review.md`).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| N/A       | N/A        | N/A                                 |
