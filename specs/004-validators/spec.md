# Feature Specification: Response & Input Validators (Phase 1)

**Feature Branch**: `004-validators`
**Created**: 2026-05-29
**Status**: Draft
**Input**: Port legacy LLM-output validators into the engine. Phase 1 = three validators needing no RAG/grounding infrastructure (false-promise, format-injection, identity-and-provider-guard). Fact-grounding deferred to Phase 2.

## Overview

The engine generates assistant replies for digital twins used in sales/support conversations. Today **nothing checks a generated reply against business-safety rules before it reaches the customer** — a twin can promise a discount it can't authorize, claim a delivery date nobody agreed to, or misstate which company/service it represents. Each such reply is a trust, legal, or commercial liability.

This feature ports the legacy **validator** subsystem (domain-tuned guards) into the engine as a composable pipeline that inspects each reply (and each inbound message) and remediates unsafe content before delivery.

**Scope — Phase 1 (this spec):** three validators that need no knowledge-base/retrieval infrastructure:
1. **false-promise** — catches commitments to external parties the business hasn't authorized.
2. **format-injection** — strips prompt/format-injection artifacts from inbound input.
3. **identity-and-provider-guard** — keeps the twin from misrepresenting its identity or service provider.

**Deferred to Phase 2 (separate spec):** the **fact-grounding** validator — its legacy retriever was a stub and the engine has no knowledge-base/vector store; its grounding source (memory-derived vs. retrieval) is an open infrastructure decision out of scope here.

## Clarifications

### Session 2026-05-29

- **Q (FR-017, streaming):** The engine has a streaming endpoint; a mutating/blocking validator can't act on already-sent tokens. How for Phase 1? → **A:** Phase 1 covers the **non-streaming reply path only**. Replies via the streaming endpoint are NOT validated in Phase 1 (tracked limitation; twins use the non-streaming path). Streaming + mutating validators deferred.
- **Q (FR-015, defaults):** Default behavior when a tenant/persona has no validator config? → **A:** **All Phase-1 validators `active` by default** (enforce out of the box). `dry-run` remains an available per-validator mode operators opt into for staged rollout.
- **Q (FR-007, false-promise remediation):** Default action on an unauthorized external promise? → **A:** **append_disclaimer** (legacy default; less destructive; preserves the dialogue). `block` remains configurable.
- **Q (FR-008, identity-guard):** Recon on the legacy identity-and-provider-guard was thin. How to lock it? → **A:** **Pull a focused recon (R-identity) before locking FR-008.** identity-guard stays in Phase 1 scope but is specified at intent level only until the recon report lands; it is excluded from planning until then.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - False-promise guard (Priority: P1)

A twin, mid-conversation, generates a reply that promises an external customer something the business hasn't authorized ("Да, сделаю вам скидку 30%", "Привезём завтра к 9 утра"). Before that reply is delivered or stored, the system detects the unauthorized promise and either appends a clarifying disclaimer or blocks the reply, substituting a safe fallback.

**Why this priority**: Highest business/legal/trust risk. A single false promise can cost money or breach contract. This validator alone is a viable, valuable MVP slice.

**Independent Test**: Send a reply containing a known external-promise pattern through the pipeline with the validator active; confirm the delivered reply carries a disclaimer (or is blocked) and a verdict is recorded. Send a benign reply; confirm it passes untouched with no LLM judge call.

**Acceptance Scenarios**:

1. **Given** an active false-promise validator, **When** a reply contains an EXACT external-promise pattern, **Then** the judge is invoked and, if it rules the promise external/unauthorized, the configured remediation (disclaimer or block) is applied before persistence.
2. **Given** a reply with no promise-like content, **When** the pipeline runs, **Then** the deterministic prefilter does not trip, **no** LLM judge call is made, and the reply is delivered unchanged.
3. **Given** the judge times out or errors, **When** the prefilter match was EXACT, **Then** the system fails **closed** (applies remediation); **When** the match was AMBIGUOUS, **Then** the system fails **open** (delivers the reply).
4. **Given** a promise directed at internal staff (not a customer), **When** the judge evaluates it, **Then** the verdict is `no_op` and the reply is delivered unchanged.

---

### User Story 2 - Identity & provider guard (Priority: P2)

A customer asks "вы бот?" or "какой компанией вы работаете?", and the twin generates a reply that breaks persona — admitting it's an AI when policy forbids, or naming the wrong company/provider. The guard detects the violation and remediates before delivery.

**Why this priority**: Persona integrity is core to the product (digital *twins of people*). A broken-character or wrong-provider reply undermines the entire premise. Second only to direct financial false-promises.

**Independent Test**: Send replies that violate a persona's identity/provider policy; confirm each is remediated and recorded. Send a compliant reply; confirm it passes.

**Acceptance Scenarios**:

1. **Given** an active identity-guard with a persona identity/provider policy, **When** a reply violates that policy, **Then** the configured remediation is applied before persistence.
2. **Given** a compliant reply, **When** the pipeline runs, **Then** the reply is delivered unchanged.

---

### User Story 3 - Format-injection strip (Priority: P3)

An inbound user message contains prompt/format-injection artifacts (control tokens, role markers, instruction-hijack scaffolding). The system strips these before the message reaches generation, reducing injection risk.

**Why this priority**: Defensive hygiene. Lower business risk than P1/P2 and runs pre-generation (no reply-mutation timing concerns), so it is the simplest independent slice.

**Independent Test**: Feed a message laden with injection artifacts; confirm the sanitized message (artifacts removed) is what reaches generation, and the action is recorded.

**Acceptance Scenarios**:

1. **Given** an inbound message containing known injection/format artifacts, **When** the input stage runs, **Then** the artifacts are stripped before generation.
2. **Given** a clean inbound message, **When** the input stage runs, **Then** the message is unchanged.

---

### User Story 4 - Operator configuration & dry-run rollout (Priority: P2)

An operator enables validators gradually: first in **dry-run** (verdicts recorded, replies untouched) to measure false-positive rates per persona, then flips individual validators to **active**. Configuration is per tenant and per persona, including thresholds and timeouts.

**Why this priority**: Without dry-run, no team will trust a reply-mutating guard in production. Safe rollout is a precondition for P1/P2 being shippable, so it ships alongside them.

**Independent Test**: Configure a validator in dry-run for a persona; send a violating reply; confirm a verdict is recorded but the reply is delivered unchanged. Flip to active; confirm remediation now applies.

**Acceptance Scenarios**:

1. **Given** a validator in **dry-run** mode, **When** it would have remediated a reply, **Then** the verdict is recorded but the reply is delivered unchanged.
2. **Given** a validator in **active** mode, **When** it rules a violation, **Then** remediation is applied.
3. **Given** no configuration for a tenant/persona, **When** the pipeline runs, **Then** the system applies the documented safe default (see FR-015).

---

### Edge Cases

- A reply contains **both** an internal-directed and an external-directed promise → must remediate on the external one.
- The LLM judge returns **malformed/non-conforming** output → treated as judge error → fail-policy applies (FR-005).
- Repeated judge timeouts → must not stall the chat path indefinitely (bounded by timeout; see FR-009/SC-004).
- Prefilter **false positive** on benign text → judge returns `no_op`; cost incurred but reply unchanged (acceptable; measured via FR-012).
- A validator's own code throws → must not surface as a chat-path failure (FR-016).
- **Streaming replies**: the engine has a streaming path (002-streaming-completions) on which a validator cannot mutate/block tokens already sent. **Resolved (Phase 1): the streaming path is out of scope** — validators apply to the non-streaming path only.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST evaluate every non-streaming assistant reply through an ordered validator pipeline **after** generation and **before** the reply is persisted and returned, such that an active validator can mutate or block the reply.
- **FR-002**: The system MUST sanitize every inbound user message through input-stage validators **before** generation (format-injection strip).
- **FR-003** (false-promise): The system MUST detect candidate promise statements in a reply via a deterministic prefilter and classify each candidate as **EXACT** or **AMBIGUOUS**.
- **FR-004** (false-promise): When the prefilter flags a candidate, the system MUST invoke an LLM judge that determines whether the promise targets an **internal** party (permitted → `no_op`) or an **external** party (not permitted), returning a structured verdict in `{append_disclaimer, block, no_op}` with a confidence score.
- **FR-005** (false-promise): On judge error or timeout, the system MUST apply a fail-policy: **fail-closed** (remediate) for EXACT prefilter matches; **fail-open** (deliver) for AMBIGUOUS matches.
- **FR-006** (false-promise): The judge **minimum-confidence threshold** (default 0.7) and **judge timeout** (default 1500 ms) MUST be configurable per tenant/persona.
- **FR-007** (false-promise): On an unauthorized external promise above the confidence threshold, the system MUST apply the configured remediation. **Default remediation: append a disclaimer** to the reply (a clarifying note that the twin cannot independently commit). **block** (replace the reply with a safe fallback) is an available per-tenant/persona configuration.
- **FR-008** (identity-guard): The system MUST detect replies that misrepresent the twin's identity (e.g., claiming to be human) or leak service provider names (e.g., Anthropic, OpenAI) and remediate them by replacing the entire response with a locked acknowledgment template.
  - **Detection**: Deterministic regex-based check on both the original user message (`rawUserMessage`) and the assistant response (`responseText`).
  - **Policy Source**: Hardcoded system-managed regex patterns for detection; per-persona `fallbackMessage` (stored in the validator's row/config) for remediation.
  - **Remediation**: **rewrite** (total replacement). Replace the entire response with the configured `fallbackMessage` (default: "Да, я ИИ-ассистент Анна. Если хотите, могу передать живому оператору 😊").
  - **Tier-1 Support**: MUST support the `applyToTier1` flag to catch identity questions in the greeting stage.
- **FR-009** (format-injection): The system MUST strip known prompt/format-injection artifacts from inbound messages prior to generation, leaving clean messages unchanged.
- **FR-010** (latency model): Deterministic prefilters and input strips MUST run synchronously on every message/reply; an LLM judge MUST run **only when** its validator's prefilter flags a candidate — no unconditional LLM call may be added to the reply path.
- **FR-011** (config): Operators MUST be able to configure, per **tenant** and per **persona**: which validators are enabled, each validator's **mode** (`active` | `dry-run`), and per-validator thresholds/timeouts.
- **FR-012** (dry-run): In `dry-run` mode a validator MUST compute and record its verdict **without** mutating or blocking the reply.
- **FR-013** (observability): The system MUST record each validator execution — validator name, verdict, confidence, action taken, latency, dry-run flag, and a reference to the message/conversation — for later querying.
- **FR-014** (tenancy): All validator configuration and execution records MUST be tenant-isolated; no tenant may read another tenant's validator config or records.
- **FR-015** (defaults): When no validator configuration exists for a tenant/persona, the system MUST default to **all Phase-1 validators `active`** (enforce out of the box). `dry-run` (FR-012) remains an available per-validator mode operators opt into for staged rollout.
- **FR-016** (failure isolation): A validator's internal error MUST NOT propagate as a chat-path failure; it MUST resolve through the validator's fail-policy and be logged.
- **FR-017** (pipeline composition): The validator pipeline MUST compose with the existing dialogue-funnel hooks (003-script-funnels) in a single defined order: input strips (pre-generation) → generation → response validators (post-generation, may mutate/block) → deferred funnel slot-verification (asynchronous). Two features MUST NOT independently re-wire the same generation hook. **Phase 1 applies to the non-streaming reply path only**; replies produced via the streaming endpoint (002-streaming-completions) are NOT validated in Phase 1 (tracked limitation — see Assumptions).
- **FR-018** (auditability of remediation): When a reply is mutated or blocked, the system MUST retain the original generated reply alongside the remediated output in its execution record.

### Key Entities *(include if feature involves data)*

- **ValidatorConfig**: the per-`(tenant, persona)` policy. Attributes: enabled validators, per-validator mode (`active`|`dry-run`), per-validator thresholds (e.g., min judge confidence) and timeouts, identity/provider policy text for the identity-guard. Unique per (tenant, persona).
- **ValidatorRun**: one recorded validator execution. Attributes: tenant, persona, conversation/message reference, validator name, verdict/decision, confidence, action taken (none|disclaimer|block|strip), original vs. remediated content, latency, dry-run flag, timestamp.
- **Verdict** (value object): the outcome a validator returns to the pipeline. Attributes: decision (`pass`|`append_disclaimer`|`block`|`strip`|`no_op`), confidence, reason, matched-pattern class.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of non-streaming assistant replies pass through the validator pipeline before delivery.
- **SC-002**: On the legacy regression set of known external false-promises, ≥95% are caught (remediated) when the false-promise validator is active.
- **SC-003**: For replies that do **not** trip any prefilter, the pipeline adds **<10 ms** p95 latency and makes **zero** LLM judge calls.
- **SC-004**: For replies that trigger the judge, added latency never exceeds the configured timeout (default 1500 ms); the chat path never blocks indefinitely on a validator.
- **SC-005**: In dry-run mode, 100% of evaluated replies have a recorded verdict and **zero** are mutated or blocked.
- **SC-006**: Zero cross-tenant leakage of validator configuration or execution records (verified by tenant-isolation tests).
- **SC-007**: Zero chat-path failures (HTTP 5xx) attributable to a validator's internal error — all such errors resolve via fail-policy and are logged.
- **SC-008**: An operator can move a validator from dry-run to active for a single persona without affecting other personas or tenants.

## Assumptions

- Phase 1 targets the **non-streaming** reply path only; replies generated via the streaming endpoint are not validated in Phase 1 — a tracked safety gap, accepted because twins use the non-streaming path; streaming validation is a future phase.
- Default posture is **enforce** (all Phase-1 validators active when unconfigured, per FR-015); teams wanting staged rollout opt individual validators into `dry-run`.
- The false-promise judge's "internal vs external" determination relies on conversation context the engine can supply at the post-generation hook; the exact context fields (e.g., open-order/operator-notified signals from legacy) will be confirmed during planning.
- The LLM judge calls reuse the engine's existing LLM provider path; a shared internal LLM client will be extracted (coordinated with 003-script-funnels — see Dependencies).
- Validator configuration and run records persist in the engine's existing tenant-scoped datastore with row-level tenant isolation.
- Legacy validator logic is ported and adapted to engine conventions, not adopted from an external framework (port-the-moat strategy).

## Dependencies

- **003-script-funnels**: shares the post-generation hook on the chat path and also requires an asynchronous LLM seam. The shared LLM-client extraction and the generation-hook ordering (FR-017) MUST be coordinated so the two features do not refactor the same integration point independently.
- **Shared LLM client**: the engine's current model-call path is not reusable from outside the chat service; an internal reusable client/util is a prerequisite for the false-promise and identity judges.
- **Persona policy**: identity-guard requires per-persona identity/provider policy data; whether this extends the persona record or lives in ValidatorConfig is a planning decision.

## Out of Scope (Phase 1)

- **fact-grounding** validator and any knowledge-base/retrieval (RAG) infrastructure (Letta-vs-BM25/embedding) — deferred to Phase 2.
- A generic-safety OSS layer (PII/toxicity via a TypeScript-native library) — parked as a possible future layer.
- Mutating/blocking validators over the **streaming** reply path (pending FR-017 clarification).
- Re-engagement subsystem (separate; no shared code).
- Operator UI for validator config/results (config via API/seed in Phase 1).
