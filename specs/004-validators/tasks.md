---

description: "Task list for Response & Input Validators (Phase 1)"
---

# Tasks: Response & Input Validators (Phase 1)

**Input**: Design documents from `/specs/004-validators/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, basic structure, shared dependency installs

- [ ] T001 [SETUP] Verify Drizzle setup and project dependencies in `packages/core`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

- [ ] T002 [DB] Update schema in `packages/core/src/db.ts` with `validator_configs` and `validator_runs` tables, then generate migration
- [ ] T003 [BE] Extract shared LLM client to `packages/core/src/services/llm-client.ts`
- [ ] T004 [BE] Implement `ValidatorContext` and interfaces from `contracts/validator.ts` into `packages/core/src/types/validator.ts`
- [ ] T005 [BE] Implement `packages/core/src/services/validators/pipeline.ts` orchestrator logic and DB persistence for config/runs

---

## Phase 3: User Story 1 - False-promise guard (Priority: P1) 🎯 MVP

**Goal**: Catch commitments to external parties the business hasn't authorized

**Independent Test**: Send a reply containing a known external-promise pattern through the pipeline; confirm the delivered reply carries a disclaimer (or is blocked) and a verdict is recorded.

### Tests for User Story 1 ⚠️

- [ ] T006 [BE] [US1] Integration tests for `false-promise` validator behavior (exact match, LLM judge, fail-policy)

### Implementation for User Story 1

- [ ] T007 [BE] [US1] Implement `false-promise.ts` validator logic with deterministic prefilter and LLM judge integration
- [ ] T008 [BE] [US1] Integrate validator pipeline post-generation hook in `packages/core/src/services/chat-service.ts`

**Checkpoint**: False-promise guard is functional and records runs in DB

---

## Phase 4: User Story 3 - Format-injection strip (Priority: P3)

**Goal**: Strip prompt/format-injection artifacts from inbound input.

**Independent Test**: Feed a message laden with injection artifacts; confirm the sanitized message is what reaches generation.

### Tests for User Story 3 ⚠️

- [ ] T009 [BE] [US3] Unit tests for `format-injection.ts` stripping behavior

### Implementation for User Story 3

- [ ] T010 [BE] [US3] Implement `format-injection.ts` validator logic
- [ ] T011 [BE] [US3] Integrate input strip pipeline pre-generation hook in `packages/core/src/services/chat-service.ts`

**Checkpoint**: Inbound messages are sanitized before generation

---

## Phase 5: User Story 2 - Identity & provider guard (Priority: P2)

**Goal**: Detect identity-denial / provider-name leakage in assistant output.

**Independent Test**: Send replies that violate a persona's identity/provider policy; confirm each is remediated.

### Tests for User Story 2 ⚠️

- [ ] T014 [BE] [US2] Unit tests for `identity-and-provider-guard.ts` regex behavior

### Implementation for User Story 2

- [ ] T015 [BE] [US2] Implement `identity-and-provider-guard.ts` validator logic
- [ ] T016 [BE] [US2] Integrate US2 into the pipeline orchestrator in `pipeline.ts`

---

## Phase 6: Operator configuration & dry-run rollout (Priority: P2)

**Goal**: Enable gradual rollout and per-validator mode (`active` vs `dry-run`)

### Tests for Phase 6 ⚠️

- [ ] T012 [BE] [US4] Integration test for pipeline honoring `dry-run` vs `active` mode configuration overrides from DB

### Implementation for Phase 6

- [ ] T013 [BE] [US4] Update `pipeline.ts` to fetch and cache tenant/persona configuration from `validator_configs` (with FR-015 defaults fallback) and honor `dry-run` behavior

---

## Dependency Graph

### Dependencies

T001 → T002, T003, T004
T002 + T004 → T005
T003 + T005 → T007
T007 → T006
T007 → T008
T005 → T010
T010 → T009
T010 → T011
T005 → T015
T015 → T014
T015 → T016
T005 + T008 + T011 + T016 → T013
T013 → T012

---

## Parallel Lanes

| Lane | Agent Flow | Tasks | Blocked By |
|------|-----------|-------|------------|
| 1 | [SETUP] | T001 | — |
| 2 | [DB] | T002 | T001 |
| 3 | [BE] (Core) | T004 → T005 | T001, T002 |
| 4 | [BE] (LLM) | T003 | T001 |
| 5 | [BE] (US1) | T007 → T006, T008 | T003 + T005 |
| 6 | [BE] (US3) | T010 → T009, T011 | T005 |
| 7 | [BE] (US2) | T015 → T014, T016 | T005 |
| 8 | [BE] (Config)| T013 → T012 | T005 + T008 + T011 + T016 |

---

## Agent Summary

| Agent | Task Count | Can Start After |
|-------|-----------|-----------------|
| [SETUP] | 1 | immediately |
| [DB] | 1 | T001 |
| [BE] | 14 | T001 |

**Critical Path**: T001 → T004 → T005 → T007 → T008 → T013 → T012

---

## Agent Dispatch Plan

| Agent | Subagent | Skills | Input Context | Tasks | Files |
|-------|----------|--------|---------------|-------|-------|
| `[SETUP]` | — (orchestrator) | — | plan.md §structure | T001 | `packages/core/package.json` |
| `[DB]` | `database-architect` | `database-design` | data-model.md | T002 | `packages/core/src/db.ts` |
| `[BE]` | `backend-specialist` | `api-patterns`, `system-design-patterns` | contracts/validator.ts, spec.md | T003, T004, T005, T006, T007, T008, T009, T010, T011, T012, T013, T014, T015, T016 | `packages/core/src/types/`, `packages/core/src/services/validators/`, `packages/core/src/services/chat-service.ts`, `packages/core/src/services/llm-client.ts` |

---

## Implementation Strategy

### MVP First (User Story 1 Only)
1. Complete T001-T005 (Foundational)
2. Complete T006-T008 (US1: False-promise MVP)
3. Validate independent operation.

### Full Delivery
1. Add US3 (Format-injection strip)
2. Add Config & Dry-run rollout logic
3. Verify all constraints and db persistence.
