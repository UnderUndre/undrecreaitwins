You are a senior developer, systems architect, and expert code reviewer. Your goal is to perform an adversarial, independent review of a new SpecKit feature under the rules of the UnderUndre constitution (specifically Principle VI: Cross-AI Review Gate).

### Target Directory & Feature:
- Feature Slug: `003-script-funnels`
- Directory: `specs/003-script-funnels`

### Your Task:
Conduct an independent, critical review of the `spec.md`, `plan.md`, and `tasks.md` files. Probe for:
1. **Logical consistency**: Are spec requirements mapped to plan elements and tasks?
2. **Hidden assumptions**: What is assumed but not explicitly stated?
3. **Missing edge cases**: Concurrency, max/empty inputs, partial failures, synonyms/morphology issues.
4. **Failure modes**: External dependencies (Postgres, Redis, LLM API) down or slow.
5. **Security & privacy**: Multi-tenant isolation leakage, input validation gaps, secret handling.
6. **Performance & scale**: <100ms match hot path guarantee, N+1 queries, concurrency clobbering.
7. **Alternative approaches**: What did the authors miss?
8. **Constitution alignment**: Cross-check every task/plan item against `.specify/memory/constitution.md`.

You must self-identify by your platform/engine (e.g. `claude`). 
Write your final review file to: `specs/003-script-funnels/reviews/claude.md`.

---

### Output File Format

Use this exact structure for `specs/003-script-funnels/reviews/claude.md`:

```markdown
# SpecKit Review: 003-script-funnels

**Reviewer**: claude
**Reviewed at**: [ISO 8601 Timestamp]
**Commit**: [Leave empty or use current if git available]
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/funnel-api.yaml, research.md, quickstart.md

## Summary

[2-3 sentences: top-level take on design strength and critical vulnerability/weakness.]

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | CRITICAL | Security | ... | ... |
| F2 | HIGH | Edge case | ... | ... |
| F3 | MEDIUM | Performance | ... | ... |

## Alternative approaches considered

[If any, list here. Otherwise skip.]

## VERDICT

\```yaml
verdict: PASS | MEDIUM | HIGH | CRITICAL
reviewer: claude
reviewed_at: [ISO Timestamp]
commit: [SHA]
critical_count: [N]
high_count: [N]
medium_count: [N]
low_count: [N]
\```
```

Use the following severity definitions:
- **CRITICAL**: Constitution violation, missing core artifact, security/data-loss hole, or blocker.
- **HIGH**: Significant gap (missing edge case in main flow, weak invariant, ambiguous requirement needing rework).
- **MEDIUM**: Quality/robustness concern (minor edge case, undocumented assumption, poor naming).
- **LOW**: Polish/refactoring suggestion.

*Note: VERDICT can only be PASS if critical_count == 0 and high_count == 0.*

---

### Feature Context & Artifacts

Here is the complete gathered context of the feature. Use these raw files to conduct the review.

#### 1. Specification (`spec.md`)
```markdown
# Feature Specification: Script Funnels — Dialog Funnel Runtime

**Feature Branch**: `003-script-funnels`  
**Created**: 2026-05-29  
**Status**: Draft  
**Input**: User description: "Port legacy Script Funnels engine (dialog funnel runtime) into the engine. Strategy = port-the-moat / OSS-the-commodity. RUNTIME → ENGINE: deterministic fragment scorer (Russian stemmer + synonym groups + weighted scoring, <100ms hot path, no synchronous LLM at match time); stage controller (transitions / resolution / reset-guard + stuck safety-net); slot verification (async LLM off the hot path, concurrency-safe). Hook into the response pipeline. New ingestion endpoint for funnel definitions mirroring the existing persona pattern. Editor is a separate product-side feature."

## Clarifications

### Session 2026-05-29

- Q: When no fragment clears the relevance threshold (off-script), how should the runtime hand off the reply? → A: Configurable per funnel (`offScriptBehavior`): `steer` (default — yield to unscripted generation with the current stage/goal injected as context), `abstain` (yield to plain unscripted generation), or `catch_all` (use a funnel-defined fallback fragment, no generative call). Rationale: `steer` and `abstain` cost the same (both invoke generation), so `steer` dominates on quality at equal cost; `catch_all` is the only zero-LLM path.
- Q: What should the stuck safety-net DO when the threshold is reached? → A: Configurable per funnel (`stuckAction`): `yield_generation` (default — abstain for that turn so the loop breaks naturally), `handoff` (emit a handoff signal and stop scripted pushing), or `exit_stage` (transition to an author-designated exit stage). `reset`-to-start was rejected (risks re-looping the same script).
- Q: On publishing a new funnel version, what happens to in-flight conversations? → A: Pin in-flight conversations to the version they started on; only new conversations adopt the newly published version. Operators may force-reset a conversation (FR-018) to migrate it early.
- Q: How should the scorer treat language (legacy is Russian-only)? → A: Build the matching pipeline (stemming + synonyms) language-pluggable behind a language interface, but implement only Russian in this feature; additional languages arrive with the separate i18n module.

## User Scenarios & Testing *(mandatory)*

A **digital twin** (assistant) can be given a **funnel** — a scripted, goal-directed dialog plan (e.g. qualify a lead → handle objections → capture contact). When a funnel is configured, the runtime steers each reply toward the funnel's goal using fast, deterministic matching, while still sounding natural and falling back to free generation when the conversation goes off-script. The funnel runtime lives where conversations actually execute, so it adds no perceptible delay and has direct access to live conversation state.

The primary actors:
- **End user** — the person chatting with the twin; experiences instant, on-topic, goal-directed replies.
- **Operator** — the business configuring/publishing funnels (interacts via a separate authoring surface; only the *ingestion* of a finished funnel touches this runtime).

### User Story 1 - Assistant follows a configured funnel during a live conversation (Priority: P1)

When an assistant has a published funnel, every incoming user message is matched against the funnel's candidate replies ("fragments") and the best-fitting scripted reply is chosen by a deterministic scoring procedure — **without** any generative-model call to decide *which* reply to use. This is the core value: it keeps high-volume conversations on-script, fast, cheap, and reproducible.

**Why this priority**: This is the entire reason the feature exists. Without deterministic on-script selection there is no funnel runtime — stages, slots, and publishing all exist to serve it. It is independently shippable as a minimal MVP: a single-stage funnel that simply picks the right scripted reply already delivers value.

**Independent Test**: Configure an assistant with a small funnel (a handful of fragments). Send messages that clearly map to specific fragments. Verify (a) the reply is drawn from the matching fragment, (b) the same input in the same state yields the same fragment every time, (c) matching still works when the user uses synonyms or different word forms, and (d) no generative model is consulted to pick the fragment.

**Acceptance Scenarios**:

1. **Given** an assistant with a published funnel and a user message that strongly matches one fragment, **When** the message is processed, **Then** the assistant's reply is drawn from that fragment and the decision is recorded as a selection diagnostic.
2. **Given** the same user message sent twice in equivalent conversation state, **When** both are processed, **Then** the same fragment is selected both times (reproducible / deterministic).
3. **Given** a user message expressed with synonyms or inflected word forms different from the fragment's trigger phrasing, **When** processed, **Then** the fragment still matches (morphology- and synonym-tolerant).
4. **Given** a user message that matches no fragment above the relevance threshold, **When** processed, **Then** the runtime yields to unscripted generation (graceful fallback) instead of forcing a poor-fit scripted reply.
5. **Given** an assistant with **no** funnel configured, **When** any message is processed, **Then** the funnel runtime is a no-op and normal generation proceeds unchanged.

---

### User Story 2 - Stage progression with a stuck safety-net (Priority: P2)

A funnel is organized into ordered **stages** (a path toward the funnel's goal). The runtime tracks which stage each conversation is in, prefers the current stage's (and the natural next stage's) fragments when scoring, advances when the current stage's objective is resolved, can regress/reset when the conversation breaks out of the script, and — critically — detects when a conversation has been **stuck** in one stage for too many consecutive turns and fires a safety-net so the user is never trapped in a loop.

**Why this priority**: Stages give the funnel direction toward a goal/conversion; the stuck safety-net prevents the single worst failure mode of scripted bots — dead-end loops. It builds directly on P1's selection and is independently testable.

**Independent Test**: Configure a multi-stage funnel. Drive a conversation that satisfies stage 1 and verify it advances to stage 2 (and that stage-2 fragments are now favored). Then repeatedly send messages that fail to resolve a stage and verify the safety-net fires once the configured consecutive-turn threshold is reached.

**Acceptance Scenarios**:

1. **Given** a conversation in stage N and a message that resolves stage N's objective, **When** processed, **Then** the conversation advances to the next stage and subsequent matching favors the new stage's fragments.
2. **Given** a current stage, **When** fragments are scored, **Then** fragments belonging to the current stage (and its natural next stage) are favored over unrelated/distant fragments.
3. **Given** a conversation that has remained in the same stage across the configured number of consecutive turns without resolution, **When** the threshold is reached, **Then** a stuck safety-net action is triggered (e.g. escape / alternate path / handoff) and does not loop indefinitely.
4. **Given** a conversation where the user abandons the current stage's topic, **When** processed, **Then** the runtime may re-evaluate and move to a more appropriate stage rather than rigidly staying.
5. **Given** a user raises an objection, **When** scoring, **Then** objection-handling fragments are favored appropriately.

---

### User Story 3 - Slot capture and verification, async and non-blocking (Priority: P3)

Funnels collect structured data — **slots** (e.g. name, phone, budget, intent) — over the course of a conversation. Slot extraction/verification is the one place a generative model is acceptable, but it MUST run off the response hot path so it never delays the reply, and concurrent updates to the same conversation's slots MUST NOT lose data.

**Why this priority**: Slots are how a funnel produces business value (captured lead data), but verification is heavier and slower than matching. Isolating it from the fast path (and making it concurrency-safe) protects the P1 latency guarantee. It is independently testable and additive.

**Independent Test**: Drive a conversation that supplies slot data across several turns. Verify (a) replies are not delayed by slot processing, (b) captured slots eventually reflect the supplied values, and (c) two near-simultaneous updates to the same conversation's slots do not clobber each other.

**Acceptance Scenarios**:

1. **Given** a user message containing slot-relevant data, **When** processed, **Then** the reply is delivered without waiting on slot verification, and the slot is updated shortly afterward (eventual).
2. **Given** two updates to the same conversation's slots arriving close together, **When** both complete, **Then** no update is silently lost (concurrency-safe via version checking).
3. **Given** slot verification fails, is unavailable, or is inconclusive, **When** it completes (or times out), **Then** the conversation continues and the slot is left unfilled/flagged rather than blocking the dialog.

---

### User Story 4 - Publish and version funnels without disrupting live conversations (Priority: P4)

Funnel definitions are ingested per assistant (and per tenant). Operators will edit and re-publish funnels while real conversations are in progress. Publishing a new version MUST NOT strand, break, or crash an in-flight conversation: it either continues safely on a consistent definition or migrates cleanly. New conversations pick up the new version.

**Why this priority**: It enables safe day-to-day operation but is not required to demonstrate the funnel runtime's core value; it gates production rollout rather than the MVP. Independently testable.

**Independent Test**: Start a conversation on funnel v1. Publish v2 with changed stages/fragments. Verify the in-flight conversation continues to behave consistently and that new conversations use v2. Submit a malformed funnel and verify it is rejected without affecting the active version.

**Acceptance Scenarios**:

1. **Given** a well-formed funnel definition submitted for an assistant, **When** ingested, **Then** it becomes the active definition for new conversations and is isolated to its tenant.
2. **Given** an in-flight conversation on a prior funnel version, **When** a new version is published, **Then** the conversation continues without error.
3. **Given** a malformed/invalid funnel definition, **When** submitted, **Then** it is rejected with a clear reason and the previously active definition stays in effect.

### Edge Cases

- **Empty / whitespace-only user message** → no crash; falls through to fallback generation.
- **Message in a language the funnel does not support** → matches poorly → graceful fallback (documented assumption: primary language is Russian).
- **No funnel configured for the assistant** → runtime is a complete no-op; normal generation path is untouched.
- **Funnel with a single stage and/or a single fragment** → still selects/falls back correctly.
- **Conversation resumed after a long idle gap** → stage state, stuck counter, and captured slots are restored from persisted state.
- **Two fragments tie on score** → a deterministic, stable tiebreak is applied (reproducible).
- **Stuck threshold reached repeatedly** → safety-net fires without entering an infinite loop.
- **Slot verification backend unavailable / times out** → reply is still sent on time; slot is retried or flagged.
- **Funnel re-published mid-turn** (between match and persist) → the turn uses a single consistent definition snapshot.
- **Relevance threshold set very high or very low** → high = almost always fallback; low = almost always on-script; both behave predictably without error.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST select the best-fitting scripted fragment for an incoming user message using a deterministic scoring procedure that does NOT invoke a generative model at match time.
- **FR-002**: Fragment selection MUST be reproducible — identical conversation state plus identical input yields an identical selection (including a deterministic, stable tiebreak when scores are equal).
- **FR-003**: Fragment matching MUST tolerate morphological variation (inflected word forms) and configured synonym groups for the conversation's language. The matching pipeline (stemming + synonyms) MUST be structured behind a language interface so additional languages can be added later; only Russian is implemented in this feature.
- **FR-004**: Scoring MUST favor fragments belonging to the conversation's current stage and its natural next stage over unrelated fragments.
- **FR-005**: Matching MUST account for fragment type, including objection-handling fragments, favoring them when the user raises an objection.
- **FR-006**: System MUST track each conversation's current funnel stage and persist it across turns.
- **FR-007**: System MUST advance a conversation to the next stage when the current stage's objective is resolved.
- **FR-008**: System MUST support stage regression/reset when the conversation no longer fits the current stage.
- **FR-009**: System MUST detect when a conversation has been stuck in one stage for a configurable number of consecutive turns and trigger a configurable safety-net action (`stuckAction`) that does not loop indefinitely. Supported actions: `yield_generation` (abstain to unscripted generation for that turn — default), `handoff` (emit a handoff signal and stop scripted pushing for the conversation), or `exit_stage` (transition to an author-designated exit stage).
- **FR-010**: System MUST extract configured slots from the conversation.
- **FR-011**: Slot extraction/verification MUST run off the response hot path and MUST NOT delay the user-facing reply.
- **FR-012**: Concurrent slot updates to the same conversation MUST NOT lose data (concurrency-safe via version checking / compare-and-set).
- **FR-013**: When no fragment meets the configurable relevance threshold, the system MUST apply the funnel's configured off-script behavior (`offScriptBehavior`): `steer` (yield to unscripted generation with the current stage/goal injected as context — default), `abstain` (yield to plain unscripted generation), or `catch_all` (use a funnel-defined fallback fragment, no generative call).
- **FR-014**: System MUST ingest funnel definitions scoped per assistant and per tenant via a dedicated ingestion interface that mirrors the existing persona ingestion pattern.
- **FR-015**: System MUST isolate funnel definitions and conversation funnel state per tenant (no cross-tenant visibility).
- **FR-016**: System MUST version funnel definitions and allow publishing a new version without disrupting in-flight conversations: in-flight conversations remain pinned to the funnel version they started on, and only new conversations adopt the newly published version. (A reset per FR-018 migrates a conversation to the active version early.)
- **FR-017**: System MUST reject malformed funnel definitions with a clear, actionable reason and leave the previously active definition in effect.
- **FR-018**: System MUST support resetting a conversation's funnel state.
- **FR-019**: System MUST emit selection diagnostics for each match decision (chosen fragment, contributing score signals, whether fallback occurred) for observability and debugging.
- **FR-020**: System MUST be a no-op for assistants without a configured funnel, leaving normal generation unaffected.
- **FR-021**: System MUST integrate into the existing response-generation pipeline so funnel selection occurs as part of producing the assistant's reply.
- **FR-022**: The scoring weights, current-stage boost, next-stage bonus, stuck threshold, relevance threshold, off-script behavior (`offScriptBehavior`), and stuck-safety-net action (`stuckAction`) MUST be configurable (carrying the legacy defaults where applicable), per funnel/assistant.

### Key Entities *(include if feature involves data)*

- **Funnel (Script)**: A per-assistant, tenant-scoped, versioned scripted-dialog definition. Contains stages, fragments, slot definitions, and behavior settings (scoring weights, current-stage boost, next-stage bonus, relevance threshold, off-script behavior, stuck threshold + action); has an active version and validation status.
- **Stage**: An ordered phase of the funnel with an objective and a natural successor. A conversation occupies exactly one stage at a time.
- **Fragment**: A candidate scripted reply with trigger signals (phrases/keywords), a stage association, a type (e.g. normal vs objection-handling), and weighting inputs used by the scorer.
- **Slot**: A named piece of structured data the funnel aims to capture, with extraction/verification rules and a fill/verification status.
- **Conversation funnel state**: Per-conversation state — current stage, consecutive-stuck counter, captured slot values, pinned funnel version, and last selection — persisted across turns and concurrency-safe.
- **Selection diagnostic**: A record of a single match decision: chosen fragment (or fallback), score breakdown by signal, and the resulting stage transition (if any).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For at least 99% of turns, the funnel's scripted-reply selection completes fast enough to add no human-perceptible delay to the reply (selection step under 100 ms at match time).
- **SC-002**: Identical input in identical conversation state produces an identical fragment selection 100% of the time (reproducibility).
- **SC-003**: On a representative replay of historical conversations, the ported runtime selects the same fragment as the legacy system on at least 95% of turns (behavioral parity with the legacy engine).
- **SC-004**: The stuck safety-net fires 100% of the times the configured consecutive-turn threshold is reached; no conversation remains stuck in a single stage beyond that threshold.
- **SC-005**: Replies are never delayed by slot verification (0% of turns blocked on slot processing); captured slot values reflect supplied data within one subsequent turn (or a short bounded window).
- **SC-006**: Publishing a new funnel version causes zero errors or breaks in in-flight conversations (0 disruptions).
- **SC-007**: Funnel definitions and conversation funnel state are never visible across tenants (0 cross-tenant leaks).
- **SC-008**: Concurrent slot updates to the same conversation lose 0 updates.
- **SC-009**: For assistants without a funnel, response latency and behavior are statistically unchanged from before the feature (0 measurable regression).

## Assumptions

- The conversation's primary language is **Russian** (the legacy stemmer and synonym groups are Russian). The matching pipeline is built **language-pluggable** behind a language interface, but only Russian is implemented in this feature; other languages arrive with the separate i18n module. Messages in unsupported languages match poorly and fall through to the configured off-script behavior.
- Funnel definitions are **authored elsewhere** (a visual editor is a separate, product-side feature). This runtime only **ingests** a finished funnel definition through an interface that mirrors how persona configs are ingested today.
- This runtime lives in the **engine**, where conversations/messages are the source of truth, co-located with the response pipeline for zero-latency access to live conversation state (per the boundary ownership audit).
- A generative model is used **only** for asynchronous slot verification — never for match-time fragment routing or stage decisions.
- The two scripted-data structures (funnel definitions + fragments) are ported in their legacy shape; funnel config is owned engine-side (clean slate — no pre-existing funnel models elsewhere).
- Scoring weights, current-stage boost, next-stage bonus, stuck threshold, and relevance threshold are ported from the legacy defaults and exposed as configuration.

## Out of Scope

- The visual funnel **editor / authoring UI** (separate product-side feature).
- The cross-repo **compile/push mechanics** of how an authored funnel reaches this runtime, beyond defining the ingestion interface contract.
- **Migrating existing legacy funnel data** into the new store (a separate migration effort).
- **Additional language packs** beyond Russian. The language *seam* (pluggable interface) is in scope; non-Russian stemming/synonym implementations are not.
- Funnel-performance **analytics dashboards / reporting** (this runtime emits raw diagnostics only).
- Re-engagement and validator runtimes (separate ports, tracked independently).
```

#### 2. Implementation Plan (`plan.md`)
```markdown
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
```

#### 3. Task Breakdown (`tasks.md`)
```markdown
# Tasks: Script Funnels — Dialog Funnel Runtime

**Input**: Design documents from `specs/003-script-funnels/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/funnel-api.yaml`

## Agent Tags

| Tag | Agent | Domain |
|-----|-------|--------|
| `[SETUP]` | — (orchestrator) | Project init, shared types, dependencies |
| `[DB]` | database-architect | Drizzle schema, migrations |
| `[BE]` | backend-specialist | Funnel runtime, Scorer, Services, API routes |
| `[E2E]` | test-engineer | Integration and E2E tests |

## Phase 1: Setup & Shared Infrastructure

**Purpose**: Core types, dependencies, and database schema foundation

- [ ] T001 [SETUP] Add `natural` dependency to `packages/core/package.json` for `PorterStemmerRu`
- [ ] T002 [SETUP] Define funnel types in `packages/shared/src/types.ts`: `Funnel`, `Stage`, `Fragment`, `Slot`, `ConversationFunnelState`
- [ ] T003 [DB] Create Drizzle schema for funnels in `packages/core/src/models/funnels.ts`, `funnel-stages.ts`, `funnel-fragments.ts`, `funnel-slots.ts`, `conversation-funnel-states.ts`
- [ ] T004 [DB] Register new models in `packages/core/src/models/index.ts` and `relations.ts`
- [ ] T005 [DB] Generate and run Drizzle migration for funnel tables

**Checkpoint**: Shared types and database schema ready

---

## Phase 2: User Story 1 - Deterministic Fragment Selection (Priority: P1) 🎯 MVP

**Goal**: Select scripted replies using Russian stemmer without LLM call

**Independent Test**: Mock conversation state + message -> Scorer returns expected fragment content

### Implementation for User Story 1

- [ ] T006 [BE] [US1] Create `packages/core/src/services/funnel/scorer.ts` — Implement `FragmentScorer` with `natural.PorterStemmerRu`, exact match, synonym weighting, and objection weighting (FR-005).
- [ ] T007 [BE] [US1] Create `packages/core/src/services/funnel/funnel-runtime.ts` — Core runtime logic: fetch active funnel version, invoke scorer, handle off-script behavior (`steer`, `abstain`, `catch_all`) (FR-013).
- [ ] T008 [BE] [US1] Integrate `FunnelRuntime` into `ChatService.complete` in `packages/core/src/services/chat-service.ts` — check for funnel before LLM call.
- [ ] T009 [BE] [US1] Implement selection diagnostics emitting chosen fragment and score signals (FR-019).
- [ ] T010 [E2E] [US1] Create `packages/api/tests/integration/funnel-matching.test.ts` — Verify deterministic matching for Russian messages with stems/synonyms, objection fragments, and no-op regression (SC-009).

**Checkpoint**: US1 functional — deterministic scripted replies work for single-stage funnels

---

## Phase 3: User Story 2 - Stage Progression & Stuck Safety (Priority: P2)

**Goal**: Track stages, advance on resolution, and fire stuck safety-net

**Independent Test**: Conversation advances stage on objective resolution; safety-net fires after N turns

### Implementation for User Story 2

- [ ] T011 [BE] [US2] Update `FunnelRuntime` to track `current_stage_id` and `consecutive_stuck_count` in `conversation_funnel_states` table.
- [ ] T012 [BE] [US2] Implement Stage Boost in `FragmentScorer` (current/next stage bonus).
- [ ] T013 [BE] [US2] Implement stage transition logic (advance/regression) in `FunnelRuntime`.
- [ ] T014 [BE] [US2] Implement Stuck Safety-Net (FR-009): detect threshold and trigger `stuckAction` (abstain, handoff, exit_stage).
- [ ] T015 [E2E] [US2] Create `packages/api/tests/integration/funnel-stages.test.ts` — Verify stage advancement and stuck safety-net activation.

**Checkpoint**: US2 functional — multi-stage funnels with safety-net are reliable

---

## Phase 4: User Story 3 - Async Slot Capture (Priority: P3)

**Goal**: Extract slots via async LLM call without blocking response

**Independent Test**: Slot is captured and verified 1-2 turns after being supplied in message

### Implementation for User Story 3

- [ ] T016 [BE] [US3] Implement `SlotVerificationService` in `packages/core/src/services/funnel/slot-verification.ts` — extract slots from message context using LLM.
- [ ] T017 [BE] [US3] Add `message.processed` internal event emitter or Redis queue to trigger async verification.
- [ ] T018 [BE] [US3] Implement concurrency-safe slot updates in `packages/core/src/services/funnel/funnel-repository.ts` (FR-012) using version check.
- [ ] T019 [E2E] [US3] Create `packages/api/tests/integration/funnel-slots.test.ts` — Verify slots are captured and concurrency is handled.

**Checkpoint**: US3 functional — lead data is captured asynchronously

---

## Phase 5: User Story 4 - Ingestion & Versioning (Priority: P4)

**Goal**: Ingest funnel definitions and pin in-flight conversations to versions

**Independent Test**: Ingest new version -> in-flight conversation continues on old; new conversation uses new

### Implementation for User Story 4

- [ ] T020 [BE] [US4] Create `packages/core/src/services/funnel/funnel-repository.ts` — Implement funnel/stage/fragment CRUD with optimistic locking and validation logic (FR-017).
- [ ] T021 [BE] [US4] Create `packages/api/src/routes/funnels.ts` — Fastify routes for funnel ingestion mirroring persona pattern with strict Zod validation.
- [ ] T022 [BE] [US4] Implement version pinning in `FunnelRuntime` (FR-016) — conversations keep version until reset.
- [ ] T023 [BE] [US4] Implement `/v1/conversations/:id/funnel/reset` endpoint (FR-018).
- [ ] T024 [E2E] [US4] Create `packages/api/tests/integration/funnel-ingestion.test.ts` — Verify ingestion, versioning, reset logic, and tenant isolation (SC-007).

**Checkpoint**: US4 functional — funnels can be safely published and managed

---

## Phase 6: Polish & Verification

- [ ] T025 [SETUP] Final documentation updates in `specs/003-script-funnels/quickstart.md`
- [ ] T026 [BE] Code cleanup and performance audit of scorer hot path
- [ ] T027 [E2E] Run full integration test suite and validate `SC-001` latency goal

---

## Dependency Graph

### Dependencies

T001 → T002, T003              # project setup unlocks schema
T002 + T003 → T004             # types + schema before registration
T004 → T005                    # registration before migration
T005 → T006, T020              # migration before service/repo
T020 → T021                    # repo before api routes
T006 → T007                    # scorer before runtime
T007 → T008, T011              # runtime before integration/stages
T008 → T009                    # integration before diagnostics
T009 → T010                    # diagnostics before integration test
T011 → T012, T013              # runtime tracking before scoring/transitions
T013 → T014                    # transitions before safety-net
T014 → T015                    # safety-net before stage test
T011 → T016                    # state tracking before slot extraction
T016 → T017                    # extraction before async hook
T017 + T018 → T019             # hook + concurrency before slot test
T021 → T022                    # routes before version pinning
T022 → T023                    # versioning before reset endpoint
T023 → T024                    # reset before ingestion test

---

## Parallel Lanes

| Lane | Agent Flow | Tasks | Blocked By |
|------|-----------|-------|------------|
| 1 | [SETUP] | T001, T002 | — |
| 2 | [DB] | T003 → T004 → T005 | T001, T002 |
| 3 | [BE] | T006 → T007 → T008 → T009 | T005 |
| 4 | [BE] | T020 → T021 → T022 → T023 | T005 |
| 5 | [BE] | T011 → T012, T013 → T014 | T007 |
| 6 | [BE] | T016 → T017 → T018 | T011 |
| 7 | [E2E] | T010, T015, T019, T024 | relevant BE tasks |

---

## Agent Summary

| Agent | Task Count | Can Start After |
|-------|-----------|-----------------|
| [SETUP] | 3 | immediately |
| [DB] | 3 | T001 |
| [BE] | 18 | T005 |
| [E2E] | 4 | T009, T014, T017, T023 |

**Critical Path**: T001 → T003 → T004 → T005 → T006 → T007 → T011 → T013 → T014 → T015

---

## Agent Dispatch Plan

| Agent | Subagent | Skills | Input Context | Tasks | Files |
|-------|----------|--------|---------------|-------|-------|
| `[SETUP]` | — | — | research.md §1 | T001, T002, T025 | `package.json`, `packages/shared/src/types.ts` |
| `[DB]` | `database-architect` | `database-design` | data-model.md | T003, T004, T005 | `packages/core/src/models/` |
| `[BE]` | `backend-specialist` | `api-patterns`, `system-design-patterns` | research.md §2-6, contracts/ | T006-T009, T011-T014, T016-T018, T020-T023, T026 | `packages/core/src/services/funnel/`, `packages/api/src/routes/` |
| `[E2E]` | `test-engineer` | `testing-patterns` | spec.md §User Scenarios | T010, T015, T019, T024, T027 | `packages/api/tests/integration/` |
```

#### 4. Data Model (`data-model.md`)
```markdown
# Data Model: Script Funnels

## 1. Funnels Table (`funnels`)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Unique identifier |
| `tenant_id` | UUID | FK -> tenants | Owner tenant |
| `name` | String | | Human-readable name |
| `persona_id` | UUID | FK -> personas | Associated persona |
| `config` | JSONB | | Weights, thresholds, off-script behavior |
| `version` | BIGINT | DEFAULT 0 | Optimistic locking |
| `is_active` | Boolean | | Current published version |
| `created_at` | Timestamp | | |
| `updated_at` | Timestamp | | |

## 2. Stages Table (`funnel_stages`)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Unique identifier |
| `funnel_id` | UUID | FK -> funnels | Parent funnel |
| `name` | String | | Stage name |
| `order` | Integer | | Sequence in funnel |
| `objective` | Text | | Goal of this stage |
| `next_stage_id` | UUID | FK -> funnel_stages | Natural successor |
| `stuck_action` | String | | Override stuck action for this stage |

## 3. Fragments Table (`funnel_fragments`)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Unique identifier |
| `stage_id` | UUID | FK -> funnel_stages | Associated stage |
| `type` | Enum | `normal`, `objection` | Fragment type |
| `content` | Text | | The scripted reply text |
| `triggers` | JSONB | | Phrases, keywords, synonyms |
| `score_weight` | Float | | Base weight for scorer |

## 4. Slots Table (`funnel_slots`)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK | Unique identifier |
| `funnel_id` | UUID | FK -> funnels | Parent funnel |
| `name` | String | | Slot name (e.g. `user_budget`) |
| `description` | Text | | For LLM verification |
| `validation_rules` | JSONB | | Regex or range checks |

## 5. Conversation Funnel State Table (`conversation_funnel_states`)

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `conversation_id` | UUID | PK, FK -> conversations | Parent conversation |
| `funnel_id` | UUID | FK -> funnels | Current funnel version pinned |
| `current_stage_id` | UUID | FK -> funnel_stages | Current stage |
| `consecutive_stuck_count` | Integer | DEFAULT 0 | Counter for safety-net |
| `captured_slots` | JSONB | | `{ slot_name: { value: any, verified: boolean } }` |
| `version` | BIGINT | DEFAULT 0 | Optimistic locking |
| `updated_at` | Timestamp | | |
```

#### 5. OpenAPI Contracts (`contracts/funnel-api.yaml`)
```yaml
openapi: 3.0.3
info:
  title: Script Funnels Ingestion API
  version: 1.0.0
paths:
  /v1/funnels:
    post:
      summary: Ingest a new funnel version
      tags: [Funnels]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/FunnelDefinition'
      responses:
        '201':
          description: Funnel ingested
    get:
      summary: List funnels
      tags: [Funnels]
      responses:
        '200':
          description: List of funnels

components:
  schemas:
    FunnelDefinition:
      type: object
      required: [name, persona_id, stages]
      properties:
        name: { type: string }
        persona_id: { type: string, format: uuid }
        config:
          type: object
          properties:
            relevance_threshold: { type: number, default: 0.5 }
            off_script_behavior: { type: string, enum: [steer, abstain, catch_all], default: steer }
            stuck_threshold: { type: integer, default: 3 }
        stages:
          type: array
          items:
            $ref: '#/components/schemas/StageDefinition'
    
    StageDefinition:
      type: object
      required: [name, order, fragments]
      properties:
        name: { type: string }
        order: { type: integer }
        objective: { type: string }
        fragments:
          type: array
          items:
            $ref: '#/components/schemas/FragmentDefinition'
    
    FragmentDefinition:
      type: object
      required: [type, content, triggers]
      properties:
        type: { type: string, enum: [normal, objection] }
        content: { type: string }
        triggers:
          type: object
          properties:
            phrases: { type: array, items: { type: string } }
            synonyms: { type: object, additionalProperties: { type: array, items: { type: string } } }
```

#### 6. Research Notes (`research.md`)
```markdown
# Research: Script Funnels — Dialog Funnel Runtime

## 1. Russian Stemmer Investigation

The requirement for a deterministic fragment scorer with a Russian stemmer can be met using the `natural` library or `snowball-stemmer.jsx`.

- **Decision**: Use `natural` (specifically `natural.PorterStemmerRu`) because it is well-tested, supports multiple languages (for future FR-003), and includes utilities for tokenization and string distance which will be useful for scoring.
- **Performance**: Stemming a typical message (<500 characters) takes ~1-5ms on Node.js, well within the 100ms budget.

## 2. Ingestion Pattern (FR-014)

The existing persona ingestion pattern in `packages/api/src/routes/personas.ts` uses:
1. Fastify routes with Zod validation.
2. `PersonaRepository` in `packages/core` for Drizzle-based CRUD.
3. Optimistic locking via `version` column.

- **Decision**: Mirror this exactly for funnels.
  - `POST /v1/funnels`
  - `GET /v1/funnels`
  - `GET /v1/funnels/:id`
  - `PATCH /v1/funnels/:id` (with If-Match support)
  - `DELETE /v1/funnels/:id`

## 3. Storage and Concurrency (FR-012, FR-015)

- **Funnels/Fragments/Stages**: Store in PostgreSQL using Drizzle.
- **Conversation State**: Store in PostgreSQL (conversation metadata) or Redis (for high-frequency access).
- **Concurrency**: Use a `version` column on the conversation funnel state table. Use `UPDATE ... WHERE version = :expected` for slot updates and stage transitions.

## 4. Async Slot Verification (FR-011)

Slot verification requires an LLM call but must not block the response.

- **Strategy**: 
  1. `ChatService` emits a `message.processed` event (internal or via Redis).
  2. A `SlotVerificationService` listens to this event.
  3. It identifies missing slots for the current funnel/stage.
  4. It calls the LLM with the context to extract/verify slots.
  5. It updates the conversation state if a slot is confirmed.

## 5. Scoring Algorithm (FR-001, FR-002)

Deterministic scoring components:
1. **Exact Match**: Highest weight.
2. **Stemmed Match**: High weight (Porter stemmer).
3. **Synonym Match**: Medium weight (from funnel-defined synonyms).
4. **Stage Boost**: Current stage (+X), Next stage (+Y).
5. **Type Boost**: Objection handler boost when objection detected (simple keyword/regex or state).

- **Tiebreak**: Alphabetical by fragment ID or deterministic hash to ensure reproducibility.

## 6. Integration Hook (FR-021)

Hook into `ChatService.complete` and `ChatService.completeStream`.

```typescript
// Pseudocode integration
const funnelResult = await funnelService.processMessage(tenantId, personaId, conversationId, userMessage);
if (funnelResult.type === 'scripted') {
  return funnelResult.scriptedReply;
} else if (funnelResult.type === 'steer') {
  // Add funnel context to LLM prompt
}
```

#### 7. Quickstart (`quickstart.md`)
```markdown
# Quickstart: Script Funnels

## 1. Ingest a Funnel

```bash
curl -X POST http://localhost:3000/v1/funnels \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: your-tenant-id" \
  -d '{
    "name": "Lead Qualification",
    "persona_id": "your-persona-id",
    "stages": [
      {
        "name": "Greeting",
        "order": 0,
        "objective": "Say hello and ask for interest",
        "fragments": [
          {
            "type": "normal",
            "content": "Привет! Хотите узнать больше о нашем продукте?",
            "triggers": {
              "phrases": ["привет", "здравствуйте", "интересно"]
            }
          }
        ]
      }
    ]
  }'
```

## 2. Start a Conversation

Chat with the persona as usual. If your message matches a fragment, the assistant will use the scripted reply immediately.

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: your-tenant-id" \
  -d '{
    "model": "your-persona-slug",
    "messages": [
      { "role": "user", "content": "Привет, расскажите подробнее" }
    ]
  }'
```

## 3. Verify Selection

Check selection diagnostics in the response or logs.

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Привет! Хотите узнать больше о нашем продукте?"
      }
    }
  ],
  "metadata": {
    "funnel_selection": {
      "fragment_id": "...",
      "score": 0.95,
      "type": "scripted"
    }
  }
}
```

#### 8. Project Constitution (`.specify/memory/constitution.md`)
```markdown
# UnderUndre AI Helpers Constitution

Binding principles for `clai-helpers` CLI + the curated `.claude/` template it ships. Every `/speckit.*` command checks plans and tasks against this file. Violations halt work until resolved or the constitution is explicitly amended.

## Core Principles

### I. Source of Truth Discipline

`.claude/` is **the** authoritative AI configuration. All downstream formats (`.github/prompts/`, `.github/instructions/*.instructions.md`, `.gemini/`, `GEMINI.md`, `.github/copilot-instructions.md`) are **generated**, never hand-edited.

- Edits flow one direction: `.claude/` → transformers → consumer tree.
- Any reverse flow (editing a generated file) is an incident and must be rolled back via `clai-helpers sync`.
- Hand-written instruction files under `.github/instructions/{project,persona,coding}/` are the explicit exception and are preserved by pipeline exclusion, not by luck.

### II. Transformer, Not Fork

New AI-tool target = one new transformer in `packages/cli/src/transformers/` + registration + pipeline entry in `helpers.config.ts`. Duplicating `.claude/` into a new directory tree is forbidden.

- Rationale: two copies of the same instruction drift. The CLI pipeline is the anti-drift discipline.
- Corollary: `.agent/`, `.gemini/`, `.github/prompts/` etc. MUST be produced by the pipeline, not maintained by hand.

### III. Protected Slots over Hand-Editing

Project-specific overrides inside managed files MUST use `<!-- HELPERS:CUSTOM START --> … <!-- HELPERS:CUSTOM END -->` markers. These survive `sync`. Unmarked hand-edits to managed files are lost silently on next sync — by design.

- Consumer projects never edit generated trees directly.
- Upstream improvements that would benefit every consumer go through `UnderUndre/ai` + `sync`, not local patch.

### IV. SemVer Discipline in the 0.x Zone (NON-NEGOTIABLE)

While `clai-helpers` is pre-1.0:

- **Breaking change** → MINOR bump (de facto major in 0.x semantics).
- **Feature** → MINOR bump.
- **Bugfix** → PATCH bump.
- **`chore:` / `docs:` / `refactor:` / `ci:` / `test:` / `build:`** → NO bump. Every `chore: bump version` commit is a smell.
- Going to `1.0.0` is a one-way public promise of API stability. Not before migration notes, deprecation cycles, and a tagged RC.

Full framework: `.claude/skills/semver-versioning/SKILL.md`. Bump via `/bump` command — never by hand-editing `package.json#version`.

### V. Token Economy for AI Artifacts

Every file in `.claude/` earns its place by being invoked. Decorative clones, stale mirrors, and "just in case" agents bloat the context window of every downstream Claude session.

- A file not referenced by any command, agent, or skill in 60 days is a candidate for deletion.
- `ultrathink` markers belong on entry points (commands + primary agents + decision-framework skills), not on every file. Each marker costs reasoning budget on load.
- Persona flavor (catchphrases, aphorisms) MUST be opt-in via a separate transpile target so non-Russian-speaking consumers can omit it.

### VI. Cross-AI Review Gate (NON-NEGOTIABLE)

`/speckit.implement` MUST NOT proceed without explicit gate approval. The gate requires:

1. `/speckit.analyze` written `specs/<slug>/reviews/analyze.md` with verdict ∈ {PASS, OVERRIDDEN}.
2. At least **2 distinct external AI reviewers** (Codex Desktop, Antigravity, Gemini CLI, Copilot, or Claude in an independent session) wrote `specs/<slug>/reviews/<provider>.md` via `/speckit.review` with verdict ∈ {PASS, OVERRIDDEN}.

Rationale: the model that wrote the spec is the worst auditor of the spec. Independent eyes find what the author already rationalized away. Two reviewers is the minimum to distinguish a real signal from a single-model blind spot.

Override is permitted via `--override-gate <reason>` passed to `/speckit.implement`. Every override is logged to `specs/<slug>/reviews/_gate-override.md` with timestamp, actor, commit SHA, and reason. Frequent overrides on a single feature are an incident, not a workflow.

Reviewers identify themselves by tool — `claude`, `codex`, `antigravity`, `gemini`, `copilot`. Two reviews from the same provider count as one. The gate trusts the provider tag in the VERDICT block; falsifying it defeats the purpose.

### VII. Artifact Versioning

Every pipeline stage that mutates a feature artifact (specify, clarify, plan, tasks, review) MUST tag the commit via `.specify/scripts/{bash,powershell}/snapshot-stage.{sh,ps1}` using the convention `<stage>/<slug>/v<N>`.

- Tags are the **only** historical record. **No parallel `.history/` files** — git is the history. Duplicating into `specs/<slug>/.history/` is an anti-pattern: it drifts and bloats the tree.
- `/speckit.diff <slug>` reads tags to compare iterations without speculative file copies.
- `/speckit.retrospective` reads `tasks/<slug>/v1` → HEAD to bound the implementation lifecycle and surface lessons-learned.
- The snapshot script is **idempotent** via `--points-at HEAD` guard — re-running a speckit command on the same commit reuses the existing tag instead of polluting the namespace.
- Reviewers (`/speckit.review`) only need ONE of them to call snapshot — the idempotency guard ensures parallel reviewers don't duplicate.

### VIII. Self-Maintaining Knowledge

The AI workflow infrastructure MUST keep itself current. Lessons learned are captured into staged knowledge; recurring patterns get promoted into skills/agents; project-wide spec drift is corrected actively. The repo is a learning system, not a static template.

**Version**: 1.4.0 | **Ratified**: 2026-04-17 | **Last Amended**: 2026-05-06
```

---

Now, review the input artifacts, apply the review guidelines, write the required file `specs/003-script-funnels/reviews/claude.md`, and output a summary of your findings and your final verdict here.
```

---
### Сводка выполненной работы
1. Полностью исследована папка с артефактами спецификации `003-script-funnels`. Собраны и вычищены от номеров строк файлы `spec.md`, `plan.md`, `tasks.md`, `data-model.md`, `research.md`, `quickstart.md` и YAML контракт `funnel-api.yaml`.
2. Из директории `.specify/memory/` извлечена конституция проекта `constitution.md`, чтобы проверяющий агент мог сопоставить план с архитектурными догмами проекта.
3. Составлен подробный, структурированный промт для независимого ревью в новом треде. В промте зафиксированы роли, критерии строгости оценок (CRITICAL / HIGH / MEDIUM / LOW), структура выходного файла `specs/003-script-funnels/reviews/claude.md`, а также внедрен весь исходный код документов.

Ну, проветришься — заходи.