# Feature Specification: Agentic Loop Runtime Readiness

**Feature Branch**: `013-agentic-runtime-readiness`
**Created**: 2026-06-07
**Status**: Draft
**Input**: User description: "на 2 хвоста" — the two runtime gaps that block the Hermes agentic loop (spec 010) from actually running after the standalone-compose image-namespace fix: (1) the Hermes CLI is not available to the engine runtime, and (2) the Honcho memory client speaks an API the deployed Honcho no longer serves, so twin memory silently degrades to a no-op.

## Context *(why this exists)*

Spec 010 (Hermes Executor) defined the agentic loop: the engine drives a per-tenant `hermes acp` subprocess (ACP/JSON-RPC over stdio) and stores working memory in Honcho. Two gaps prevent that loop from running in a deployed stack:

1. **Hermes runtime absence.** `HermesExecutor` requires `HERMES_ACP_CMD` and `spawn`s it on the first agentic turn ([hermes-executor.ts:86-95](../../packages/core/src/services/hermes/hermes-executor.ts), [hermes-adapter.ts:9](../../packages/core/src/services/hermes/hermes-adapter.ts)), but **nothing guarantees `hermes` is resolvable** where the engine runs. Hermes is a Python CLI (`hermes_cli`, installed today only in a dev-host venv). An engine Dockerfile **exists** (`packages/api/Dockerfile`) but is **Node-only** (`node:20-alpine`, multi-stage pnpm build) — no Python, no Hermes — and there is **no startup preflight** — so a missing/incompatible Hermes surfaces as an opaque `spawn ENOENT` to the **first end-user turn**, not at boot.

2. **Honcho API drift.** `HonchoClient` targets the legacy `/apps/{appId}/users/{userId}/...` REST surface ([honcho-client.ts:31-58](../../packages/core/src/services/hermes/honcho-client.ts)). The deployed image is Honcho **v3.x** (`ghcr.io/plastic-labs/honcho:v3.0.9`), whose API is reorganised around workspaces/peers. Every call is wrapped in `try/catch` that returns `[]`/no-ops on failure, so memory **silently stops working** — turns succeed, but twins never persist or recall anything, and nothing reports the degradation.

3. **Agentic path unwired.** Even with Hermes present and Honcho on v3, the live reply path does not use them: `ChatService` calls `llm.complete`/`completeStream` directly with **Letta** memory ([chat-service.ts:186](../../packages/core/src/services/chat-service.ts)) and never routes through `turn-router` → `HermesExecutor.runAgentTurn` (`specs/main/requirements.md`: "the agentic executor is not yet wired"). So gaps 1–2 are **inert until the live path is wired** — an end-to-end agentic turn (SC-001) cannot occur without it. *(Surfaced by review — codex F1.)*

This feature makes these gaps explicit, fail-loud where they should, and closed.

## Clarifications

### Session 2026-06-07
- **Q: Engine deployment model?** → **Both.** Ship a reproducible engine **container image** (converted `packages/api/Dockerfile`, Node + Python, Hermes CLI on PATH) for prod-like one-command deploy, **and** keep a documented/verifiable **host prerequisite** path for local dev (today's venv). (resolves FR-004)
- **Q: Existing Honcho data on v3 cutover?** → **Disposable/fresh.** Honcho is reconstructible from the SoR (spec 010 §c); no data of record lives only there. Start clean on cutover, no data migration. (resolves FR-010)
- **Q: Version pinning?** → **Pin exact.** Hermes `0.15.1`; the Honcho client targets `v3.0.9` (matching the deployed image tag). No floating ranges. (resolves FR-011)
- **Q: Worker/channel Dockerfiles in scope?** → **No.** Engine + Hermes + Honcho memory only; worker/channel Dockerfiles belong to a separate "containerize the stack" feature. (sets scope boundary)

### Session 2026-06-08 (review remediation — codex + gemini)
- **Engine Dockerfile is NOT new — it exists** (`packages/api/Dockerfile`, `node:20-alpine`, Node-only). Task = **convert** to Node+Python+Hermes, preserving the pnpm workspace build + entrypoint. (codex F3)
- **End-to-end agentic turn needs the ChatService→turn-router→`runAgentTurn` wiring** (010 left it undone). Added as **US3 (P1)**; SC-001 reworded to require it. (codex F1)
- **Base image / Python**: convert alpine → **`node:20-bookworm-slim`** (glibc, reliable Python wheels); Python **3.11** (bookworm default); `pipx` with `PIPX_BIN_DIR=/usr/local/bin` so `hermes` resolves on a global PATH regardless of runtime user. (gemini F2/F3)
- **Preflight robustness**: strict **5 s timeout** → `check_failed`; use a **shared `HERMES_ACP_CMD` parser** and check the *configured* executable, not a literal `hermes`. (gemini F1, codex F6)
- **Honcho perf/race**: **cache** resolved workspace/peer/session IDs in-process; **409 → GET** idempotent create; concurrency test. (codex F7, gemini F4/F5)
- **Permanent-mismatch test**: RED-first test against a legacy/no-`/v3` API asserting the **permanent** signal on a pinned health field. (codex F5)
- **Honcho v3 assumption confirmed** (research §a, ~0.95) — no longer a flagged assumption.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agentic turns actually execute (Priority: P1)

As an **operator** deploying the Twin Engine, when a tenant's twin takes an agentic turn, the turn runs end-to-end instead of crashing because the Hermes runtime is missing.

**Why this priority**: Without a resolvable Hermes CLI, **every** agentic turn dies (`spawn ENOENT`). This is a hard, total blocker for the loop — nothing in spec 010 works. The failure is also invisible until a real user triggers it, which is the worst possible place to discover it.

**Independent Test**: Deploy the stack, send one message that routes to the agentic path, and observe a completed turn (streamed answer, `stopReason: end_turn`). Separately, deliberately break the Hermes runtime and confirm the engine refuses to start (or reports unhealthy) with an actionable error *before* any turn is attempted.

**Acceptance Scenarios**:

1. **Given** a correctly deployed engine runtime, **When** `runAgentTurn` is invoked (the executor is called — live-path wiring is US3), **Then** the engine spawns `hermes acp`, drives the ACP handshake, and the turn completes without a spawn/runtime error.
2. **Given** the Hermes CLI is absent or unresolvable on the engine's PATH, **When** the engine starts up, **Then** it fails fast with a clear, typed configuration error naming the missing dependency — it does **not** defer the failure to the first user turn.
3. **Given** a Hermes whose ACP protocol version is incompatible with what the engine speaks, **When** the engine performs its startup preflight, **Then** it reports the version incompatibility explicitly rather than failing mid-conversation.

---

### User Story 2 - Twins remember across turns (Priority: P2)

As an **end-user** talking to a twin, my working/user-model memory is actually written and recalled across turns, instead of being silently dropped.

**Why this priority**: Memory degrades *gracefully* today (turns still succeed), so this is not a total outage like US1 — but a twin with no memory is a degraded product, and the failure is **silent**, which means it can ship unnoticed. Fixing US1 makes the loop run; fixing US2 makes it useful.

**Independent Test**: With Honcho running, complete a turn that establishes a fact, then a later turn that should recall it; verify the recall reflects the stored fact (memory round-trip). Separately, stop Honcho and confirm turns still complete (degraded) **and** that the degradation is visible in logs/metrics/health.

**Acceptance Scenarios**:

1. **Given** a running deployed Honcho (v3), **When** the engine writes a message/insight for `(tenant, persona[, externalUser])` and later reads it back, **Then** the write and read succeed against the deployed API version (no silent no-op).
2. **Given** Honcho is unavailable, **When** an agentic turn runs, **Then** the turn still completes without memory, **and** the memory failure is logged and surfaced via a signal (metric/health), not swallowed invisibly.
3. **Given** two distinct tenants, **When** each writes memory, **Then** neither tenant can read the other's memory (per-tenant isolation holds in the v3 namespace model).

---

### User Story 3 - Live chat path routes through the agentic executor (Priority: P1)

As an **end-user** messaging an agent-enabled twin, my turn is handled by the agentic loop (`runAgentTurn`), not the thin completion path — otherwise the Hermes runtime (US1) and Honcho memory (US2) are provisioned but never exercised.

**Why this priority**: `ChatService` currently calls `llm.complete`/`completeStream` directly with Letta memory and never invokes `turn-router`/`HermesExecutor` (spec 010 left this unwired). Without it, US1+US2 are ready-but-uncalled plumbing and SC-001 (end-to-end agentic turn) is unreachable. P1 — it's the bridge that makes the feature's headline value real. *(Surfaced by review — codex F1. Scope decided: owned by 013, not deferred to 010.)*

**Independent Test**: Send a non-scripted message to an agent-enabled persona; confirm the reply was produced via `runAgentTurn` (an `agent_runs` row / ACP session exists), not the thin completion path — with fallback to completion only on Hermes outage/timeout.

**Acceptance Scenarios**:

1. **Given** an agent-enabled persona and a non-scripted turn, **When** the reply path runs, **Then** it routes through `turn-router` → `HermesExecutor.runAgentTurn` (not `llm.complete` directly).
2. **Given** Hermes is unavailable or over budget, **When** an agentic turn is attempted, **Then** the path falls back to thin completion (degraded, not failed).
3. **Given** a scripted/funnel turn (spec 003), **When** it runs, **Then** it stays deterministic — the agentic path does not hijack scripted stages.

---

### Edge Cases

- **Hermes present but wrong version** → ACP protocol mismatch; preflight must catch it, not the first turn.
- **Hermes spawns but per-tenant isolation must hold** → spec 010 T000d showed Hermes' native memory is process-global (cross-tenant leak), mandating process-per-tenant with isolated `HERMES_HOME`. This feature MUST NOT regress that isolation.
- **Honcho endpoint shape differs in v3** → the migration must map the engine's `(tenant, persona, externalUser)` identity onto the v3 namespace primitives; the exact mapping is an implementation detail for the plan, but per-tenant isolation and SoR-reconstructibility (spec 010 §c) are invariants.
- **Pre-existing Honcho data in the old shape** → on first deploy against v3, legacy-shaped data may be unreadable. **Resolved (CQ2): store is disposable/fresh — rebuilt from SoR, no migration.**
- **Honcho transient errors vs hard API mismatch** → graceful degradation should cover transient outages, but a *permanent* API mismatch (wrong version) should be loud, not hidden behind the same `catch`.
- **Deployment model split** → the engine must work **both** in a container (image installs Hermes on PATH) and on a host (Hermes on host PATH) — both are in scope (CQ1). "On PATH" is resolved per the runtime context.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The engine runtime environment MUST make the Hermes agent CLI resolvable such that the configured `HERMES_ACP_CMD` spawns successfully (no `ENOENT`).
- **FR-002**: The provided Hermes version MUST be compatible with the ACP wire protocol the engine speaks (ACP `protocolVersion 1`; reference baseline `hermes-agent` v0.15.1, verified in spec 010 §i).
- **FR-003**: The engine MUST verify Hermes availability **and** ACP compatibility at startup (preflight) and, on failure, surface a clear typed configuration error — it MUST NOT defer the failure to the first user turn.
- **FR-004**: The Hermes runtime MUST be provisioned for **both** engine deployment models (CQ1): (a) the **existing** engine container image (`packages/api/Dockerfile`) **converted** from Node-only (`node:20-alpine`) to a Node+Python base (`node:20-bookworm-slim`, glibc) that installs the Hermes Python CLI on a **global** PATH (`PIPX_BIN_DIR=/usr/local/bin`), **preserving the current pnpm workspace build and entrypoint**; **and** (b) a **host-process** path — Hermes documented and verifiable as a host prerequisite for local dev. (codex F3, gemini F2/F3)
- **FR-005**: The Honcho client MUST communicate using the API version served by the deployed Honcho image (v3.x), so that working/user-model memory is actually written and retrieved.
- **FR-006**: Honcho memory operations MUST remain non-fatal to a turn when Honcho is unavailable (graceful degradation preserved from current behaviour).
- **FR-007**: Honcho memory degradation/failure MUST be observable — a structured log AND a **pinned health field** (`/v1/health.checks.honcho_memory`) AND a `honcho_degraded` metric — so a silent no-op cannot ship unnoticed. A **permanent** API-version mismatch (e.g. 404 on the `/v3` path) MUST be distinguishable from a **transient** outage (connect-refused/5xx/timeout): the permanent case raises the health field (loud); the transient case warns and degrades. (codex F5)
- **FR-008**: Per-tenant memory isolation MUST hold in the Honcho v3 namespace model — one tenant MUST NOT be able to read another tenant's memory.
- **FR-009**: Honcho MUST remain reconstructible from the engine System of Record — nothing of record may live only in Honcho (portability invariant, spec 010 §c).
- **FR-010**: On cutover to Honcho v3 the existing store is treated as **disposable** (CQ2) — started fresh and rebuilt from the SoR (per FR-009); **no data migration** is required or performed.
- **FR-011**: Hermes version and the Honcho API target MUST be **pinned to exact versions** (CQ3): Hermes `0.15.1`; the Honcho client targets `v3.0.9` (matching the deployed image tag). No floating ranges — a runtime that boots today MUST boot identically tomorrow.
- **FR-012**: The startup preflight (FR-003) MUST be governed by an explicit enablement predicate (`AGENTIC_EXECUTOR_ENABLED`) — enabled deploys enforce the preflight; agents-disabled deploys skip it and start normally. The predicate's source MUST be a single documented config (compose/host), not inferred from persona data. (codex F4)
- **FR-013**: The Honcho client MUST avoid per-turn N+1 setup — resolved workspace/peer/session IDs are cached in-process (keyed by tenant/persona/session); creation MUST be idempotent (a `409`/already-exists falls back to GET the existing resource). (codex F7, gemini F4/F5)
- **FR-014**: The preflight MUST use a strict timeout (≈5 s) — a hung `hermes acp --check` fails `check_failed`, never blocking boot indefinitely — and MUST check the **configured** executable via a parser **shared** with `HermesExecutor` (not a hardcoded `hermes`). (gemini F1, codex F6)
- **FR-015**: The live reply path MUST route agent-enabled, non-scripted turns through `turn-router` → `HermesExecutor.runAgentTurn` (fallback to thin completion on Hermes outage/timeout; scripted/funnel turns stay deterministic), so US1/US2 are actually exercised. (codex F1; see US3)

### Key Entities *(include if feature involves data)*

- **Engine Runtime Environment** — the process context (container or host) running `twin-engine-api`/workers; owns PATH and runtime env (`HERMES_ACP_CMD`, `HONCHO_URL`, `AGENTIC_EXECUTOR_ENABLED`). Today: an engine image exists (`packages/api/Dockerfile`, `node:20-alpine`, Node-only) — to be converted to Node+Python+Hermes.
- **Hermes Agent CLI** — external Python CLI (`hermes_cli`), ACP-capable, spawned process-per-tenant with an isolated `HERMES_HOME`. Not an npm dependency; not a prebuilt binary.
- **Honcho Memory Namespace** — the per-`(tenant, persona[, externalUser])` memory scope; in Honcho v3 expressed via its workspace/peer primitives. Holds working/user-model memory only; never data of record.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh deploy of the standalone stack reaches a state where a non-scripted turn to an agent-enabled persona is handled by `runAgentTurn` and completes end-to-end (live path wired — US3; no `ENOENT`; engine image builds) in 100% of smoke runs. *(Runtime readiness alone — US1/US2 — is necessary but not sufficient; the US3 wiring is required for this end-to-end criterion.)*
- **SC-002**: A missing or incompatible Hermes runtime is reported at engine startup, before any user turn, with an actionable error — 0 cases where the failure first surfaces to an end-user.
- **SC-003**: A fact written to memory on one turn is retrievable on a subsequent turn (memory round-trip works) — 0% silent no-op when Honcho is healthy.
- **SC-004**: Cross-tenant memory read attempts return nothing belonging to the other tenant in 100% of isolation tests.
- **SC-005**: With Honcho stopped, 100% of agentic turns still complete (degraded, no memory), and the degradation is visible in logs and a health/metric signal.

## Out of Scope

- Full containerisation of the **worker** and **channel** services. Their Dockerfiles **exist but are Node-only** — they don't run the agentic executor, so they need no Hermes. This feature is scoped (CQ4) to the **agentic loop runtime** — engine + Hermes + Honcho memory; bringing workers/channels to parity belongs to a separate "containerize the stack" feature and is **not** needed for SC-001.
- Re-architecting Hermes process pooling, BYOK injection, or the MCP tool-gateway (owned by spec 010).
- Honcho feature work beyond API-version compatibility (e.g. dialectic/insight tuning).

## Dependencies & Assumptions

- **Depends on** the standalone-compose image-namespace fix (honcho → `ghcr.io/plastic-labs/honcho:v3.0.9`; removal of the non-existent `nousresearch/hermes-agent` service) — done on this branch.
- **Includes** the ChatService → `turn-router` → `runAgentTurn` wiring (US3 / FR-015), which spec 010 left undone. **Scope decided (2026-06-08): US3 is owned by 013** — it is 010's unfinished wiring, but it lives here so the feature delivers user-visible value (a ready runtime that's never called is dead plumbing).
- **Confirmed (research §a, ~0.95)** Honcho v3's API is the workspaces/peers model, structurally different from the legacy apps/users surface; exact field names verified via the contract test (T008).
- **Assumes** `hermes acp` runs headless on the target OS (Linux container or host); the Windows `prompt_toolkit` console issue documented for `hermes chat` does not affect the ACP stdio path (spec 010 §i verified `hermes acp --check` OK).
