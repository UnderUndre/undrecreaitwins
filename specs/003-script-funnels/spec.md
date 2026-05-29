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

---

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
- **Concurrent turns for the same conversation** (double-send, webhook retry) → turns are serialized via per-conversation lock; second message waits or yields to generation; state is never corrupted.
- **Stage with zero fragments** → rejected at ingestion (FR-017 / FR-026 validation); if reached at runtime due to data corruption, treated as off-script.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST select the best-fitting scripted fragment for an incoming user message using a deterministic scoring procedure that does NOT invoke a generative model at match time.
- **FR-002**: Fragment selection MUST be reproducible — identical conversation state plus identical input yields an identical selection (including a deterministic, stable tiebreak when scores are equal).
- **FR-003**: Fragment matching MUST tolerate morphological variation (inflected word forms) and configured synonym groups for the conversation's language. The matching pipeline (stemming + synonyms) MUST be structured behind a language interface so additional languages can be added later; only Russian is implemented in this feature.
- **FR-004**: Scoring MUST favor fragments belonging to the conversation's current stage and its natural next stage over unrelated fragments.
- **FR-005**: Matching MUST account for fragment type, including objection-handling fragments, favoring them when the user raises an objection. _(An "objection" is when the user pushes back on the funnel's goal or offering — e.g. "слишком дорого", "не интересно", "я подумаю" — triggering objection-handling fragments about pricing, value, or follow-up.)_
- **FR-006**: System MUST track each conversation's current funnel stage and persist it across turns.
- **FR-007**: System MUST advance a conversation to the next stage when the current stage's objective is resolved.
- **FR-008**: System MUST support stage regression/reset when the conversation no longer fits the current stage. Regression is detected when the winning fragment belongs to an earlier stage and its score exceeds the best current-stage fragment's score by more than the configured `stage_boost` margin.
- **FR-009**: System MUST detect when a conversation has been stuck in one stage for a configurable number of consecutive turns and trigger a configurable safety-net action (`stuckAction`) that does not loop indefinitely. Supported actions: `yield_generation` (abstain to unscripted generation for that turn — default), `handoff` (emit a handoff signal and stop scripted pushing for the conversation), or `exit_stage` (transition to an author-designated `exit_stage_id` on the stage definition). The `consecutive_stuck_count` MUST reset to 0 on stage advancement (forward or regression). The `stuckAction` MAY be overridden per stage; the stage-level value takes precedence over the funnel-level default.
- **FR-010**: System MUST extract configured slots from the conversation.
- **FR-011**: Slot extraction/verification MUST run off the response hot path and MUST NOT delay the user-facing reply. Verification attempts MUST have a per-attempt timeout (15s), a retry limit (max 2 retries with exponential backoff), and a circuit breaker (disable after 5 consecutive failures, auto-resume after 60s cooldown). Failed extractions MUST be logged and the slot left unfilled/flagged rather than blocking.
- **FR-012**: Concurrent slot updates to the same conversation MUST NOT lose data (concurrency-safe via version checking / compare-and-set).
- **FR-013**: When no fragment meets the configurable relevance threshold, the system MUST apply the funnel's configured off-script behavior (`offScriptBehavior`): `steer` (yield to unscripted generation with the current stage/goal injected as context — default), `abstain` (yield to plain unscripted generation), or `catch_all` (use a funnel-defined fallback fragment referenced by `catch_all_fragment_id` in funnel config, no generative call). When `catch_all` is configured, a valid `catch_all_fragment_id` MUST be present; ingestion rejects the definition otherwise.
- **FR-014**: System MUST ingest funnel definitions scoped per assistant and per tenant via a dedicated ingestion interface that mirrors the existing persona ingestion pattern.
- **FR-015**: System MUST isolate funnel definitions and conversation funnel state per tenant (no cross-tenant visibility).
- **FR-016**: System MUST version funnel definitions and allow publishing a new version without disrupting in-flight conversations: in-flight conversations remain pinned to the funnel version they started on, and only new conversations adopt the newly published version. (A reset per FR-018 migrates a conversation to the active version early.)
- **FR-017**: System MUST reject malformed funnel definitions with a clear, actionable reason and leave the previously active definition in effect.
- **FR-018**: System MUST support resetting a conversation's funnel state.
- **FR-019**: System MUST emit selection diagnostics for each match decision (chosen fragment, contributing score signals, whether fallback occurred) for observability and debugging.
- **FR-020**: System MUST be a no-op for assistants without a configured funnel, leaving normal generation unaffected.
- **FR-021**: System MUST integrate into the existing response-generation pipeline so funnel selection occurs as part of producing the assistant's reply.
- **FR-022**: The scoring weights, current-stage boost, next-stage bonus, stuck threshold, relevance threshold, off-script behavior (`offScriptBehavior`), and stuck-safety-net action (`stuckAction`) MUST be configurable (carrying the legacy defaults where applicable), per funnel/assistant.
- **FR-023**: System MUST support soft-deletion of funnel definitions. Soft-deleted funnels: (a) allow in-flight conversations to continue on their pinned version, (b) are treated as non-existent for new conversations, (c) are excluded from list responses.
- **FR-024**: A funnel MUST be associated with exactly one persona. One persona MAY have at most one active funnel at a time.
- **FR-025**: Each stage MUST define machine-readable `resolution_criteria` specifying when the stage objective is considered met: `fragment_selected` (a specific fragment is chosen), `slot_filled` (a specific slot receives a verified value), or `all_slots_filled` (all stage-scoped slots are filled).
- **FR-026**: Each stage MUST contain at least one fragment. Ingestion MUST reject stages with zero fragments (FR-017 scope).
- **FR-027**: The system MUST serialize concurrent turns for the same conversation to guarantee deterministic state progression. A per-conversation lock MUST prevent two simultaneous `processMessage()` calls from corrupting shared state.

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
