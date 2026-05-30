---

description: "Task list for Response & Input Validators (Phase 1)"
---

# Tasks: Response & Input Validators (Phase 1)

**Input**: Design documents from `/specs/004-validators/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

> **Test sequencing**: the unit/integration test tasks (T006, T009, T012, T014, T018) are **post-implementation verification** — the dependency graph intentionally orders them *after* the code they exercise (e.g. T007c → T006). This is verification, not RED-GREEN TDD; the "Tests ⚠️" headers mark which story each test covers, not a write-first mandate.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, basic structure, shared dependency installs

- [ ] T001 [SETUP] Verify Drizzle setup and project dependencies in `packages/core`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

- [ ] T002 [DB] Update schema in `packages/core/src/db.ts` with `validator_configs` and `validator_runs` tables, then generate migration. MUST include: (a) **RLS policies** keyed on `tenant_id` for both tables (FR-021 — a `tenant_id` column alone is not isolation); (b) unique `(tenant_id, persona_id)` on configs; (c) indexes `(tenant_id, persona_id)`, `(conversation_id)`, **`(tenant_id, created_at)`** on runs (FR-013); (d) `verdict` enum incl. `error` and `confidence` nullable. Migration emitted as a reviewable `.sql` (no direct apply).
- [ ] T003 [BE] Extract shared LLM client to `packages/core/src/services/llm-client.ts` — single extraction coordinated with 003-script-funnels (FR-017); supports a configurable `VALIDATOR_JUDGE_MODEL` cheaper than the generation model (FR-004); interface accepts a **batch** of `{ systemPrompt, userPrompt }` payloads sharing a model (Phase 1 = size 1; Phase 2 may batch — DD-001) returning a batch of responses
- [ ] T004 [BE] Implement `ValidatorContext` and interfaces from `contracts/validator.ts` into `packages/core/src/types/validator.ts` — incl. `rawUserMessage` on context (FR-008), `error` in `VerdictDecision` (FR-016), and typed per-validator configs (`FalsePromiseConfig` / `FormatInjectionConfig` / `IdentityGuardConfig`, no open `any` — FR-011)
- [ ] T005 [BE] Implement `packages/core/src/services/validators/pipeline.ts` orchestrator + DB persistence (runs/config) — MUST: route all DB access through `withTenantContext()` (FR-021); execute response validators **BLOCKING-first, REWRITE-last** so a rewrite doesn't discard an earlier append (FR-017); wrap each validator in try/catch and invoke its fail-policy on error, recording verdict `error` (FR-016a); wrap the whole orchestrator so a pipeline-level throw (or run-persist failure after a mutation) delivers the **original unmutated reply** (FR-016b); apply the **empty-output guard** (FR-019); enforce a **per-validator wall-clock budget** (default 50 ms for deterministic validators), treating overruns as fail-open (FR-022); on orchestrator failure deliver the **safest** reply — remediated if flagged, else original (FR-016b); **audit persistence is best-effort with retry** — a failed `validator_runs` write never blocks delivery of the safe reply and never surfaces the flagged original (FR-016c)

**Checkpoint**: Foundational layer ready — schema (tenant-isolated), shared LLM client, typed contracts, orchestrator skeleton with fail-isolation + ordering + empty guard.

---

## Phase 3: User Story 1 - False-promise guard (Priority: P1) 🎯 MVP

**Goal**: Catch commitments to external parties the business hasn't authorized

**Independent Test**: Send a reply containing a known external-promise pattern through the pipeline; confirm the delivered reply carries a disclaimer (or is blocked) and a verdict is recorded.

> **WRAP atomicity**: T007 (now **T007a–c**) is split into three <500 LOC, independently testable tasks (prefilter / judge / remediation) per constitution Development Workflow.

### Tests for User Story 1 ⚠️

- [ ] T006 [BE] [US1] Integration tests for `false-promise` validator behavior — exact match, AMBIGUOUS match, judge verdict, fail-closed (EXACT) vs fail-open (AMBIGUOUS), below-threshold `no_op`, multiple-external single-remediation, the benign-text no-LLM-call path (SC-003), and **load the legacy regression set, assert ≥95% of known external false-promises are remediated (SC-002)**

### Implementation for User Story 1

- [ ] T007a [BE] [US1] Implement deterministic prefilter in `false-promise.ts` — hardcoded pattern set (FR-003), classify candidates EXACT vs AMBIGUOUS, zero LLM call when nothing trips (FR-010)
- [ ] T007b [BE] [US1] Implement LLM judge call + verdict parsing in `false-promise.ts` — internal vs external decision via `VALIDATOR_JUDGE_MODEL` (FR-004), `minConfidence`/`timeoutMs` config (FR-006), below-threshold → `no_op` recorded with actual score, multiple matches → max confidence + `matchedPatterns` list (FR-007), malformed judge output → judge error → fail-policy (FR-005)
- [ ] T007c [BE] [US1] Implement remediation in `false-promise.ts` — `append_disclaimer` (default) / `block`, text from `disclaimerText` / `blockFallbackMessage` config with **language-neutral** system defaults (FR-007), fail-closed for EXACT / fail-open for AMBIGUOUS on error (FR-005); if `append_disclaimer` would exceed the configured max-reply-length, fall back to `block` instead (FR-019)
- [ ] T008 [BE] [US1] Integrate validator pipeline post-generation hook in `packages/core/src/services/chat-service.ts` — **shared hook with 003-script-funnels** (single coordinated change, not an independent re-wire — FR-017); non-streaming path only

**Checkpoint**: False-promise guard is functional and records runs in DB

---

## Phase 4: User Story 3 - Format-injection strip (Priority: P3)

**Goal**: Strip prompt/format-injection artifacts from inbound input.

**Independent Test**: Feed a message laden with injection artifacts; confirm the sanitized message is what reaches generation.

### Tests for User Story 3 ⚠️

- [ ] T009 [BE] [US3] Unit tests for `format-injection.ts` stripping behavior (incl. clean-message-unchanged and over-length input bounded by `maxInputChars`)

### Implementation for User Story 3

- [ ] T010 [BE] [US3] Implement `format-injection.ts` validator logic — strip known artifacts, cap input to `maxInputChars` before regex eval (FR-022); if stripping empties the message, trigger the **empty-input guard** (FR-024) — never pass an empty string downstream
- [ ] T011 [BE] [US3] Integrate input strip pipeline pre-generation hook in `packages/core/src/services/chat-service.ts` — enforce the empty-input guard (FR-024) at the hook: halt generation + return a safe response (clarification prompt) when the stripped message is empty/whitespace

**Checkpoint**: Inbound messages are sanitized before generation

---

## Phase 5: User Story 2 - Identity & provider guard (Priority: P2)

**Goal**: Detect identity-denial / provider-name leakage in assistant output.

**Independent Test**: Send replies that violate a persona's identity/provider policy; confirm each is remediated.

### Tests for User Story 2 ⚠️

- [ ] T014 [BE] [US2] Unit tests for `identity-and-provider-guard.ts` regex behavior — RU/EN identity questions on `rawUserMessage` + provider leaks on `responseText`, `applyToTier1` greeting-stage path, and a ReDoS-bound test (crafted long input stays within the wall-clock budget — FR-022/SC-010)

### Implementation for User Story 2

- [ ] T015 [BE] [US2] Implement `identity-and-provider-guard.ts` validator logic — inspect `rawUserMessage` + `responseText` (FR-008), rewrite to persona `fallbackMessage` (language-neutral system default), honor `applyToTier1`, bound regex via length cap / non-backtracking engine (FR-022)
- [ ] T016 [BE] [US2] Integrate US2 into the pipeline orchestrator in `pipeline.ts` as a **REWRITE (runs last)** validator that **supersedes** prior mutations (FR-017) — replaces the whole reply with `fallbackMessage`; intentionally discards an earlier disclaimer (safe: the flagged content is replaced too)

---

## Phase 6: Operator configuration & dry-run rollout (Priority: P2)

**Goal**: Enable gradual rollout and per-validator mode (`active` vs `dry-run`)

### Tests for Phase 6 ⚠️

- [ ] T012 [BE] [US4] Integration test for pipeline honoring `dry-run` vs `active` mode from DB config, **and** the FR-015 default: identity-guard is `dry-run` for a persona with no `fallbackMessage` while false-promise/format-injection are `active`

### Implementation for Phase 6

- [ ] T013 [BE] [US4] Update `pipeline.ts` to fetch and cache tenant/persona configuration from `validator_configs` (via `withTenantContext`) — **FR-015 defaults** (false-promise + format-injection active; identity-guard dry-run unless `fallbackMessage` present), cache invalidation on config UPDATE (preferred — Postgres LISTEN/NOTIFY) OR a short TTL ≤ 10s (30s is too slow for incident response — a mode flip must take effect fast), honor `dry-run` behavior (FR-011/FR-012)

---

## Phase 7: Hardening & Migration

**Purpose**: Close the deploy-day footgun and prove tenant isolation

- [ ] T017 [BE] Data-migration script (reviewable `.sql` / seed) — enumerate existing personas; for each with no `validator_configs` row, seed config so identity-guard = `dry-run` until a `fallbackMessage` is set, false-promise/format-injection = `active` (FR-015). Surface personas missing `fallbackMessage` for operator follow-up. No direct apply — emit for review. Migration MUST be idempotent (or ship a rollback script); add a smoke test asserting post-migration state: identity-guard = `dry-run` for personas without `fallbackMessage`, false-promise/format-injection = `active` (FR-015 / SC-011).
- [ ] T018 [BE] Tenant-isolation integration test (SC-006) — assert tenant A cannot read tenant B's `validator_configs` / `validator_runs` through the pipeline; verifies RLS + `withTenantContext` wiring (FR-021)
- [ ] T019 [BE] Emit streaming-bypass telemetry (FR-020) in `packages/core/src/services/chat-service.ts` (`completeStream`, the core streaming path — stays out of `packages/api` per plan §Target Platform) — when streaming serves a persona with **active** validators, log a structured warning that the reply bypassed Phase-1 validation; read active-validator state from the cached config (T013)
- [ ] T020 [BE] Audit-PII retention parity (FR-023) in `packages/core` (data-lifecycle layer) — investigate the `messages` table's retention/redaction policy and mirror it onto `validator_runs.original_content` / `remediated_content`. If parity requires a schema change, emit a reviewable migration (coordinate with `[DB]`/T002, no direct apply); if `messages` has no retention policy yet, emit a tracked follow-up rather than silently storing message bodies indefinitely

---

## Dependency Graph

### Dependencies

T001 → T002, T003, T004
T002 + T004 → T005
T003 + T005 → T007a
T007a → T007b
T007b → T007c
T007c → T006, T008
T005 → T010
T010 → T009, T011
T005 → T015
T015 → T014, T016
T005 + T008 + T011 + T016 → T013
T013 → T012, T017, T018, T019
T002 → T020

### Self-Validation Checklist

- [x] Every task ID in Dependencies exists in the task list above
- [x] No circular dependencies
- [x] No orphan task IDs
- [x] Fan-in uses `+` only, fan-out uses `,` only
- [x] No chained arrows on a single line

---

## Parallel Lanes

| Lane | Agent Flow | Tasks | Blocked By |
|------|-----------|-------|------------|
| 1 | [SETUP] | T001 | — |
| 2 | [DB] | T002 | T001 |
| 3 | [BE] (Core) | T004 → T005 | T001, T002 |
| 4 | [BE] (LLM) | T003 | T001 |
| 5 | [BE] (US1) | T007a → T007b → T007c → T006, T008 | T003 + T005 |
| 6 | [BE] (US3) | T010 → T009, T011 | T005 |
| 7 | [BE] (US2) | T015 → T014, T016 | T005 |
| 8 | [BE] (Config)| T013 → T012 | T005 + T008 + T011 + T016 |
| 9 | [BE] (Hardening)| T017, T018, T019 | T013 |
| 10 | [BE] (Audit) | T020 | T002 |

> **Shared-file serialization**: lanes are advisory. `chat-service.ts` (T008, T011, T019) and `pipeline.ts` (T005, T013, T016) are shared mutable files — tasks touching them MUST serialize (the single `[BE]` agent executes them sequentially per the dispatch plan). Genuine parallelism is limited to non-overlapping files.

---

## Agent Summary

| Agent | Task Count | Can Start After |
|-------|-----------|-----------------|
| [SETUP] | 1 | immediately |
| [DB] | 1 | T001 |
| [BE] | 20 | T001 |

**Critical Path**: T001 → T004 → T005 → T007a → T007b → T007c → T008 → T013 → T017

---

## Agent Dispatch Plan

| Agent | Subagent | Skills | Input Context | Tasks | Files |
|-------|----------|--------|---------------|-------|-------|
| `[SETUP]` | — (orchestrator) | — | plan.md §structure | T001 | `packages/core/package.json` |
| `[DB]` | `database-architect` | `database-design` | data-model.md (RLS, indexes) | T002 | `packages/core/src/db.ts` |
| `[BE]` | `backend-specialist` | `api-patterns`, `system-design-patterns` | contracts/validator.ts, spec.md FR-001–023, plan.md §Design Decisions | T003, T004, T005, T006, T007a, T007b, T007c, T008, T009, T010, T011, T012, T013, T014, T015, T016, T017, T018, T019, T020 | `packages/core/src/types/`, `packages/core/src/services/validators/`, `packages/core/src/services/chat-service.ts`, `packages/core/src/services/llm-client.ts` |

---

## Implementation Strategy

### MVP First (User Story 1 Only)
1. Complete T001–T005 (Foundational — incl. tenant isolation, fail-isolation, ordering, empty guard)
2. Complete T006–T008 (US1: False-promise MVP — prefilter/judge/remediation split)
3. Validate independent operation.

### Full Delivery
1. Add US3 (Format-injection strip) and US2 (Identity-guard, REWRITE-last)
2. Add Config & Dry-run rollout logic (T013) with FR-015 defaults
3. Run T017 migration (identity-guard → dry-run where unconfigured) + T018 isolation test + T019 streaming-bypass telemetry + T020 retention parity
4. Verify all constraints, RLS, and DB persistence.
