# Feature Specification: Engine Tuning — Adaptive Configuration Pipeline

**Feature Branch**: `026-tuning`
**Created**: 2026-06-22
**Status**: Draft
**Input**: Product spec `ai-twins/specs/024-adaptive-onboarding`, contract `ai-twins/specs/024-adaptive-onboarding/contracts/tuning-api.md`. Engine currently has NO tuning endpoints — all 4 methods return 404.

## Context

Product layer (`ai-twins`) implements UI + tRPC proxy for 4 configuration methods (doc-extraction, template-bootstrap, interview, self-tuner). Product expects Engine to expose HTTP endpoints under `/v1/personas/:personaId/tuning/*` and `/v1/tuning/drafts/*`. Engine has none of these routes. This spec defines the Engine-side implementation.

## What Already Exists (Reuse)

| Capability | Location | Reuse % |
|---|---|---|
| RAG doc chunks | `documents` table + `document_chunks` (spec 005) | 100% — Method A reads chunks |
| Chat pipeline | `ChatService` (`core/services/chat-service.ts`) | 80% — sandbox draft mode = override persona config |
| Persona CRUD | `PersonaRepository` (`core/services/persona-repository.ts`) | 100% — activate writes prompt/config |
| Funnel CRUD | `FunnelRepository` (`core/services/funnel/funnel-repository.ts`) | 100% — activate writes funnel version |
| Validator pipeline | `core/services/validators/pipeline.ts` | 90% — dry-run for quality gate |
| LLM client | `core/services/llm-client.ts` | 100% — extraction + interview + self-tuner |
| Training pipeline | `packages/training/` (trait extraction from chat logs) | 50% — Method D conversation analysis |
| Fastify route registration | `packages/api/src/server.ts` | Pattern: `fastify.register(routes)` |

## What Needs Building

1. **`tuning_drafts` DB table** (drizzle schema) — draft lifecycle: generating → ready/failed → activated/superseded/rolled-back
2. **Tuning routes** (Fastify) — all endpoints from the contract
3. **DocExtractionPipeline** — reads RAG chunks → LLM structured output → ConfigurationDraft
4. **InterviewStateMachine** — adaptive Q&A session stored per persona
5. **ConversationAnalyzer** — scans recent conversations → generates proposals
6. **SandboxDraftMode** — patches ChatService to accept draft config overlay
7. **ActivatePipeline** — atomically writes persona + funnel version + validator toggles

## User Scenarios & Testing

### User Story 1 — Doc Extraction Draft Generation (Priority: P1)

Engine receives `POST /v1/personas/:personaId/tuning/generate { method: 'doc-extraction' }`. Reads RAG chunks for the persona. Sends chunks to LLM with extraction prompt. LLM returns structured JSON: systemPrompt, funnelConfig, validatorToggles, confidence. Engine stores as draft (status: ready). Product polls `GET /v1/tuning/drafts/:draftId` until ready.

**Why this priority**: Tracer-bullet — proves the full pipeline (generate → poll → review → activate). All other methods follow the same draft lifecycle.

**Independent Test**: Upload 2-3 documents to a persona, call generate, poll until status=ready, verify draft has non-empty systemPrompt + funnelConfig.

**Acceptance Scenarios**:
1. **Given** persona has ≥1 document chunk, **When** `POST /v1/personas/:id/tuning/generate { method: 'doc-extraction' }`, **Then** returns 202 `{ draftId, status: 'generating' }` within 2s.
2. **Given** draft is generating, **When** `GET /v1/tuning/drafts/:draftId`, **Then** returns `{ status: 'generating' }` until LLM completes, then `{ status: 'ready', systemPrompt, funnelConfig, ... }`.
3. **Given** persona has 0 documents, **When** generate called, **Then** returns 400 `{ error: 'NO_DOCUMENTS', message: 'Upload at least one document first' }`.

---

### User Story 2 — Draft Activate (Priority: P1)

Engine receives `POST /v1/tuning/drafts/:draftId/activate`. Validates draft belongs to tenant + persona. Saves previous persona config as `previousSnapshot`. Applies draft: updates persona (systemPrompt, traits), creates funnel version, sets validator toggles. Returns 200 synchronously within 3s.

**Why this priority**: Without activate, the draft is useless. Pairs with P1 generation.

**Independent Test**: Generate draft → activate → verify persona systemPrompt changed in DB → rollback → verify reverted.

**Acceptance Scenarios**:
1. **Given** draft status=ready, **When** `POST /v1/tuning/drafts/:draftId/activate`, **Then** returns 200 `{ status: 'activated' }` within 3s; persona `system_prompt` updated in DB.
2. **Given** draft already activated, **When** activate again, **Then** returns 409 `{ error: 'CONFLICT' }`.
3. **Given** activated draft, **When** `POST /v1/tuning/drafts/:draftId/rollback`, **Then** persona reverted to previousSnapshot; draft status=rolled-back.

---

### User Story 3 — Interview Flow (Method C) (Priority: P2)

Engine receives `POST /v1/personas/:personaId/tuning/interview/next`. Returns first question. Product sends answer. Engine advances to next question or generates draft when all answered. State stored server-side per persona (in-memory or Redis with TTL).

**Why this priority**: Full feature parity for v1, but not a blocker for the tracer-bullet path.

**Independent Test**: Call next → answer 7 questions → verify draft created with status=ready.

**Acceptance Scenarios**:
1. **Given** no active interview, **When** `POST /v1/personas/:id/tuning/interview/next`, **Then** returns `{ question: 'Что вы продаёте?', questionId: 'q1', total: 7, current: 1 }`.
2. **Given** question q1 answered, **When** next called, **Then** returns q2 (or skips if answer already covered by docs).
3. **Given** all questions answered, **When** next called, **Then** returns `{ draftId: '...', status: 'ready' }`.

---

### User Story 4 — Self-Tuner Proposals (Method D) (Priority: P3)

Engine periodically (or on-demand) analyzes recent conversations for a persona. Detects patterns (repeated topics, failed validations, block-rate spikes). Generates proposals. Product reads via `GET /v1/personas/:personaId/tuning/proposals`.

**Why this priority**: Requires ≥20 conversations of data. Long-term value, not MVP-blocking.

**Independent Test**: Insert 20+ mock conversations with patterns → call proposals → verify proposal with signal + description + riskLevel.

**Acceptance Scenarios**:
1. **Given** persona with <20 conversations, **When** proposals requested, **Then** returns empty array + warm-up indicator.
2. **Given** persona with 25 conversations, 12 about delivery, **When** proposals requested, **Then** returns `{ proposals: [{ signal: 'repeated_topic', description: '...', riskLevel: 'low' }] }`.
3. **Given** proposal accepted, **When** `POST /v1/tuning/proposals/:id/accept`, **Then** creates draft from proposal → returns `{ draftId }`.

---

### User Story 5 — Sandbox Draft Preview (Priority: P2)

Engine receives `POST /v1/tuning/drafts/:draftId/sandbox-preview { messages }`. Loads draft config. Overrides live persona config with draft (prompt + funnel). Runs through full chat pipeline (RAG + funnel + validators in dry-run). Returns reply.

**Why this priority**: Required for DraftReview "test before activate" flow.

**Independent Test**: Create draft with different systemPrompt → send test message via sandbox-preview → verify reply uses draft prompt, not live.

**Acceptance Scenarios**:
1. **Given** draft ready, **When** `POST /v1/tuning/drafts/:draftId/sandbox-preview { messages: [...] }`, **Then** returns 200 `{ reply: '...', metadata: { draftApplied: true, overriddenParts: ['systemPrompt'] } }`.

---

### Edge Cases

- **LLM extraction timeout (>60s)**: Draft status → `failed`, `error: 'LLM_TIMEOUT'`. Product shows retry.
- **LLM returns unparseable JSON**: Fallback to partial draft (systemPrompt only, funnelConfig=null, confidence='low').
- **Concurrent generate for same persona**: Second request → 409 `{ error: 'CONFLICT_DRAFT_ACTIVE' }`.
- **Sandbox preview with empty RAG**: Works, but reply may be generic. Metadata includes `ragEmpty: true`.
- **Rollback with null previousSnapshot**: Returns 400 `{ error: 'NO_PREVIOUS_SNAPSHOT' }`.
- **Cross-tenant draft access**: All draft queries scoped by `tenantId` from auth hook. Cross-tenant → 404.
- **Generation stalled (process crash / hung LLM)**: Draft stuck in `generating` for >90s is flipped to `failed` (`error: 'GENERATION_STALLED'`) on the next poll (FR-003 reaper). Generation is in-process, so a crashed worker leaves no background retry — the poll-time reaper is the only recovery path.
- **Chained activation rollback**: Activating draft B supersedes the previously-active draft A. Rollback is permitted only on the current active draft (B); rollback on superseded A → 409 `{ error: 'DRAFT_SUPERSEDED' }`.
- **Accept/reject expired proposal**: Proposals live in a Redis cache (TTL 30min). `accept`/`reject` on an evicted/unknown `proposalId` → 404 `{ error: 'PROPOSAL_EXPIRED' }`; Product re-fetches `GET /proposals`.

## Requirements

### Functional Requirements

- **FR-001 (DB Schema)**: Engine MUST create a `tuning_drafts` table (drizzle) with fields: `id` (UUID PK), `tenantId`, `personaId`, `method` (enum: doc-extraction | template-bootstrap | interview | self-tuner), `status` (enum: generating | ready | failed | activated | superseded | rolled-back), `confidence` (high | medium | low | null), `systemPrompt` (text), `funnelConfig` (jsonb), `validatorToggles` (jsonb), `diffSections` (jsonb), `previousSnapshot` (jsonb — captures persona config + prior funnel active-version id + prior validator toggles), `signals` (jsonb — for proposals), `error` (text — error message if status=failed, e.g. 'LLM_TIMEOUT', 'GENERATION_STALLED'), `reviewVerdict` (enum: approved | rejected | null), `reviewNotes` (text, nullable), `createdAt`, `updatedAt`, `activatedAt`. Review verdict lives in its own columns — the `status` enum is NOT extended with `approved`/`rejected` (see Clarifications 2026-06-23).
- **FR-002 (Generate)**: `POST /v1/personas/:personaId/tuning/generate` MUST accept `{ method, options? }`, validate persona exists + belongs to tenant, create draft row (status: generating), enqueue async pipeline, return 202 `{ draftId, status: 'generating' }`. For v1 the async pipeline is an **in-process background task** (fire-and-forget after the 202), NOT a durable job queue; the `tuning_drafts` row is the single source of truth for progress. **`method: 'template-bootstrap'` MUST be rejected with 400 `METHOD_NOT_IMPLEMENTED`** until the follow-up spec lands (Method B deferred). **Background task wiring**: `process.nextTick(() => runGenerationPipeline(draftId, tenantId).catch(err => markDraftFailed(draftId, tenantId, err)))` — the `.catch` prevents unhandled rejections. All background DB writes MUST be wrapped in `withTenantContext(tenantId, ...)` (the request transaction is gone after the 202; RLS blocks unscoped writes).
- **FR-003 (Poll)**: `GET /v1/tuning/drafts/:draftId` MUST return full draft object. Auth inherited from shared engine hook — Bearer token bound to tenant, `X-Tenant-ID` validated against token's tenant (FR-012). **Poll-time reaper**: if the draft is `status=generating` and `now - createdAt > 90s`, the poll handler MUST first flip it to `failed` (`error: 'GENERATION_STALLED'`) and return that. Because generation is in-process (FR-002), this is the recovery path for a crashed worker or a hung LLM call. **Startup sweep**: on Fastify `onReady`, scan for `status=generating` drafts older than 5 minutes and flip to `failed` (`error: 'GENERATION_STALLED'`) — covers process restarts where nobody polls.
- **FR-004 (List)**: `GET /v1/personas/:personaId/tuning/drafts` MUST return drafts (latest first), optionally filtered by `?status=`.
- **FR-005 (Review)**: `POST /v1/tuning/drafts/:draftId/review { verdict, notes? }` MUST write `reviewVerdict` (approved | rejected) + `reviewNotes` to the draft. The `status` field is unchanged (a reviewed draft stays `ready`). Review is **advisory metadata** and does NOT gate activate (see Clarifications 2026-06-23).
- **FR-006 (Activate)**: `POST /v1/tuning/drafts/:draftId/activate` MUST synchronously: (1) save previousSnapshot (current persona config — see FR-007 for full scope), (2) mark any currently-activated (non-superseded) draft for this persona as `superseded`, (3) update persona system_prompt + traits, (4) create funnel version, (5) set validator toggles, (6) mark draft activated. Return 200 within 3s. Activate is allowed on any `status=ready` draft regardless of `reviewVerdict` (review is advisory, FR-005). **Atomicity**: steps 1–6 MUST run inside a single `withTenantContext` transaction — the repos (`PersonaRepository`, `FunnelRepository`) MUST accept an injected `tx` parameter so the caller controls the transaction boundary. If any step throws, the entire transaction rolls back (no partial activation). If repo refactoring for `tx` injection is too risky for v1, activate degrades to best-effort with compensating rollback on partial failure (documented in code).
- **FR-007 (Rollback)**: `POST /v1/tuning/drafts/:draftId/rollback` MUST restore previousSnapshot to live config. `previousSnapshot` captures **persona config (systemPrompt + traits) + prior funnel active-version id + prior validator toggles** — rollback reverses ALL three: restore persona prompt/traits, reactivate prior funnel version, restore validator toggles. Only works on the **current active draft** (`status=activated`, not yet superseded) with non-null previousSnapshot. Rollback on a `superseded` draft → 409 `{ error: 'DRAFT_SUPERSEDED' }` — activations unwind LIFO, roll back the latest activation first (see Clarifications 2026-06-23).
- **FR-008 (Sandbox Preview)**: `POST /v1/tuning/drafts/:draftId/sandbox-preview { messages }` MUST run chat pipeline with draft config overlaid on live persona. Returns reply + metadata.
- **FR-009 (Interview)**: `POST /v1/personas/:personaId/tuning/interview/next` and `POST /v1/personas/:personaId/tuning/interview/answer { questionId, answer }` MUST manage interview state (server-side, per persona, TTL 30min).
- **FR-010 (Proposals)**: `GET /v1/personas/:personaId/tuning/proposals` MUST return active proposals and cache the generated set in **Redis with TTL 30min** under stable `proposalId`s (proposals are NOT persisted in a DB table). `POST /v1/tuning/proposals/:proposalId/accept` resolves the proposal from cache and creates a draft from it. `POST /v1/tuning/proposals/:proposalId/reject` dismisses it. Cache miss / expired id on accept or reject → 404 `{ error: 'PROPOSAL_EXPIRED' }` (Product re-fetches `GET /proposals` to regenerate). See Clarifications 2026-06-23.
- **FR-011 (Concurrent Lock)**: Only one draft with status=generating per persona. Second generate → 409. **Enforcement**: partial unique index `CREATE UNIQUE INDEX ... ON tuning_drafts (persona_id) WHERE status = 'generating'` — the DB rejects the second INSERT with a unique violation, which the handler catches and returns as 409. **Stale-draft escape hatch**: before the lock check, `generate` MUST opportunistically sweep: if a `generating` draft for this persona is older than the stall threshold (90s), flip it to `failed` (`GENERATION_STALLED`) and proceed. This prevents a permanently-bricked persona if the client stops polling.
- **FR-012 (Tenant Isolation)**: ALL draft queries scoped by tenantId from auth hook (`request.tenantId`). The shared auth hook binds the Bearer token to the allowed tenant(s) and rejects mismatched `X-Tenant-ID` before RLS. Tuning routes inherit this — a caller cannot read another tenant's drafts by spoofing `X-Tenant-ID`.
- **FR-013 (Quality Gate)**: After extraction pipeline completes, confidence is determined by the LLM's self-reported `confidence` field (data-model §5 `ExtractionOutput`). Validator-based block-rate gating (generate sample replies → run through `ValidatorPipeline.validateResponse` → compute block-rate) is **deferred to v1.1** — it requires a synthetic conversation context and probe-message set that is not yet defined. For v1, `confidence: 'low'` if the LLM returned partial/unparseable JSON, otherwise the LLM's self-report.

### Key Entities

- **TuningDraft**: `{ id, tenantId, personaId, method, status, confidence, systemPrompt, funnelConfig, validatorToggles, diffSections, previousSnapshot, signals, reviewVerdict, reviewNotes }`
- **InterviewSession**: `{ personaId, currentQuestion, answers[], total, createdAt }` — ephemeral (Redis or in-memory with TTL)
- **TuningProposal**: `{ id, personaId, signal, description, riskLevel, affectedConversations, createdAt }` — ephemeral, generated from conversation analysis, cached in **Redis with TTL 30min** under a stable `id`; cache miss on accept/reject → `PROPOSAL_EXPIRED` (not persisted in DB)

## Success Criteria

### Measurable Outcomes

- **SC-001**: Doc extraction draft ready within 60s of generate call (for ≤5 documents, ≤50KB total). Full critical path budget: LLM extraction ≤45s + chunk selection/mapping ≤5s + DB writes ≤5s + quality gate (LLM self-report, no extra call) ≤5s.
- **SC-002**: Activate completes within 3s (no LLM call, pure DB writes in single transaction).
- **SC-003**: Sandbox preview returns reply within 10s (includes LLM call).
- **SC-004**: Generated systemPrompt is rated `confidence: 'high'` or `'medium'` by the LLM's self-report for 80% of test doc sets. Validator-based block-rate gating deferred to v1.1 (FR-013).
- **SC-005**: All endpoints return proper error codes (400/404/409) for edge cases — no 500s on expected failures.

## API Contract Reference

Full endpoint list + request/response shapes: `ai-twins/specs/024-adaptive-onboarding/contracts/tuning-api.md`

## Clarifications

### Session 2026-06-22

- **Q: Interview state — DB or in-memory?** → A: **Redis with TTL 30min.** Interview is ephemeral; if session expires, user restarts. No persistent table needed. If Redis unavailable, in-memory Map fallback (single-instance dev only).
- **Q: Proposal generation — on-demand or background job?** → A: **On-demand for v1.** Product calls `GET /proposals`, Engine analyzes recent conversations synchronously (≤5s for 20 conversations). Background scheduled analysis = future optimization.
- **Q: Template bootstrap (Method B) — where do templates live?** → A: **Engine DB, `templates` table** (already exists for training templates). Extend with `funnel_preset` + `validator_preset` JSONB columns. Content task = separate from code.
- **Q: Extraction prompt format?** → A: **Structured output via `response_format: { type: 'json_object' }`** (OpenAI-compatible). Prompt instructs LLM to return `{ systemPrompt, funnelStages, validatorToggles, confidence }`. Extraction prompt content = separate artefact (`extraction-prompt.md`), iterated offline.

### Session 2026-06-23

- **Q: Proposals are "ephemeral, on-demand" yet `accept/:proposalId` needs a stable id — how are proposals identified/stored between GET and accept?** → A: **Redis cache, TTL 30min.** `GET /proposals` caches the generated set under stable ids; `accept`/`reject` resolve from cache. Cache miss/expired → 404 `PROPOSAL_EXPIRED` (re-GET to regenerate). No DB table — consistent with the interview-state decision. (Applied: FR-010, TuningProposal entity, Edge Cases.)
- **Q: Review verdict `approved|rejected` is in FR-005/contract but absent from the `status` enum and has no column — where stored, does it gate activate?** → A: **Dedicated columns `reviewVerdict` + `reviewNotes`; advisory.** `status` enum is NOT extended; a reviewed draft stays `ready`. Review does NOT block activate. (Applied: FR-001, FR-005, FR-006, TuningDraft entity.)
- **Q: FR-002 says "enqueue async pipeline" — what runs generation and what rescues a draft stuck in `generating`?** → A: **In-process background task** (no durable queue for v1) + **poll-time reaper**: `generating` older than 90s → `failed` (`GENERATION_STALLED`). Durable queue is a documented future scale path. (Applied: FR-002, FR-003, Edge Cases.)
- **Q: `superseded` is in the enum but has no trigger, and chained `activate A → activate B` makes rollback ambiguous — what's the rule?** → A: **LIFO.** Activate marks the prior active draft `superseded`; rollback is allowed only on the current active draft; rollback on a superseded draft → 409 `DRAFT_SUPERSEDED`. (Applied: FR-006, FR-007, Edge Cases.)
