# Tasks: Script Funnels — Dialog Funnel Runtime

**Input**: Design documents from `specs/003-script-funnels/`
**Output**: Functional runtime integrated into `ChatService`

## Phase 1: Setup & Shared Infrastructure
- [X] T001 [SETUP] Add `natural` dependency to `packages/core/package.json` for `PorterStemmerRu`
- [X] T002 [SETUP] Define funnel types in `packages/shared/src/types.ts`: `Funnel`, `Stage`, `Fragment`, `Slot`, `ConversationFunnelState`
- [X] T003 [DB] Create Drizzle schema for funnels in `packages/core/src/models/funnels.ts`, `funnel-stages.ts`, `funnel-fragments.ts`, `funnel-slots.ts`, `conversation-funnel-states.ts`
- [X] T004 [DB] Register new models in `packages/core/src/models/index.ts` and `relations.ts`
- [X] T005 [DB] Generate and run Drizzle migration for funnel tables

**Checkpoint**: Shared types and database schema ready

## Phase 2: User Story 1 - Deterministic Fragment Selection
- [X] T006 [BE] [US1] Create `packages/core/src/services/funnel/scorer.ts` — Implement `FragmentScorer` with `natural.PorterStemmerRu`, exact match, synonym weighting, and objection weighting (FR-005).
- [X] T007 [BE] [US1] Create `packages/core/src/services/funnel/funnel-runtime.ts` — Core runtime logic: load funnel definition once at turn start (snapshot isolation), use in-process LRU cache for immutable versions, invoke scorer, handle off-script behavior.
- [X] T008 [BE] [US1] Integrate `FunnelRuntime` into `ChatService.complete` and `ChatService.completeStream` in `packages/core/src/services/chat-service.ts`.
- [X] T009 [BE] [US1] Implement selection diagnostics emitting chosen fragment and score signals (FR-019).
- [X] T010 [E2E] [US1] Create `packages/api/tests/integration/funnel-matching.test.ts` — Verify deterministic matching for Russian messages.

**Checkpoint**: Messages correctly matched to scripted fragments or fall back to LLM

## Phase 3: Stage Progression & Stuck Safety
- [X] T011 [BE] [US2] Update `FunnelRuntime` to track `current_stage_id` and `consecutive_stuck_count` in `conversation_funnel_states`.
- [X] T012 [BE] [US2] Implement Stage Boost in `FragmentScorer` (current/next stage bonus).
- [X] T013 [BE] [US2] Implement stage transition logic in `FunnelRuntime`: advance on resolution, regress on earlier stage match.
- [X] T014 [BE] [US2] Implement Stuck Safety-Net (FR-009): detect threshold and trigger `stuckAction`.
- [X] T015 [E2E] [US2] Add stage advancement scenarios to integration tests.

**Checkpoint**: Converation moves through stages based on user input

## Phase 4: Async Slot Capture
- [X] T016 [BE] [US3] Implement `SlotVerificationService` in `packages/core/src/services/funnel/slot-verification.ts` with LLM extraction and circuit breaker.
- [X] T017 [BE] [US3] Add `message.processed` async trigger behind `SlotVerificationTransport` (EventEmitter/Redis).
- [X] T018 [BE] [US3] Implement concurrency-safe slot updates in `FunnelRepository` using CAS with retry policy.
- [X] T019 [E2E] [US3] Add slot verification scenarios to integration tests.

**Checkpoint**: Entities extracted from messages and persisted reliably

## Phase 5: Ingestion & Versioning
- [X] T020 [BE] [US4] Create `packages/core/src/services/funnel/funnel-repository.ts` — CRUD with immutable versions and validation.
- [X] T021 [BE] [US4] Create `packages/api/src/routes/funnels.ts` — Fastify routes for funnel ingestion.
- [X] T022 [BE] [US4] Implement version pinning in `FunnelRuntime` (FR-016).
- [X] T023 [BE] [US4] Implement `/v1/conversations/:id/funnel/reset` endpoint (FR-018).
- [X] T024 [E2E] [US4] Add ingestion and versioning scenarios to integration tests.

**Checkpoint**: Funnels can be created, versioned, and reset per conversation

## Phase 6: Polish & Verification
- [X] T025 [SETUP] Register `funnelRoutes` in `packages/api/src/server.ts`.
- [X] T026 [BE] [US4] Add detailed logging to `FunnelRuntime` transitions.
- [X] T027 [E2E] [US1] Performance verification: ensure funnel overhead < 50ms (Turn Latency Budget).
- [X] T028 [BE] [US1] Implement per-conversation Redis advisory lock in `FunnelRuntime`.
- [X] T029 [BE] [US4] Implement funnel soft-delete endpoint `DELETE /v1/funnels/:id`.

**Checkpoint**: Feature complete, verified, and production-ready

## Summary of Implementation

| Agent | Task Range | Status |
|-------|------------|--------|
| `[SETUP]` | T001-T002, T025 | COMPLETED |
| `[DB]` | T003-T005 | COMPLETED |
| `[BE]` | T006-T009, T011-T014, T016-T018, T020-T023, T026, T028-T029 | COMPLETED |
| `[E2E]` | T010, T015, T019, T024, T027 | COMPLETED |
