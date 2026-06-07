# Feature Specification: Agentic Loop Runtime Readiness

**Feature Branch**: `013-agentic-runtime-readiness`
**Created**: 2026-06-07
**Status**: Draft
**Input**: User description: "на 2 хвоста" — the two runtime gaps that block the Hermes agentic loop (spec 010) from actually running after the standalone-compose image-namespace fix: (1) the Hermes CLI is not available to the engine runtime, and (2) the Honcho memory client speaks an API the deployed Honcho no longer serves, so twin memory silently degrades to a no-op.

## Context *(why this exists)*

Spec 010 (Hermes Executor) defined the agentic loop: the engine drives a per-tenant `hermes acp` subprocess (ACP/JSON-RPC over stdio) and stores working memory in Honcho. Two gaps prevent that loop from running in a deployed stack:

1. **Hermes runtime absence.** `HermesExecutor` requires `HERMES_ACP_CMD` and `spawn`s it on the first agentic turn ([hermes-executor.ts:86-95](../../packages/core/src/services/hermes/hermes-executor.ts), [hermes-adapter.ts:9](../../packages/core/src/services/hermes/hermes-adapter.ts)), but **nothing guarantees `hermes` is resolvable** where the engine runs. Hermes is a Python CLI (`hermes_cli`, installed today only in a dev-host venv). There is **no engine Dockerfile in the repo** (both compose files reference `packages/api/Dockerfile`, which does not exist), and there is **no startup preflight** — so a missing/incompatible Hermes surfaces as an opaque `spawn ENOENT` to the **first end-user turn**, not at boot.

2. **Honcho API drift.** `HonchoClient` targets the legacy `/apps/{appId}/users/{userId}/...` REST surface ([honcho-client.ts:31-58](../../packages/core/src/services/hermes/honcho-client.ts)). The deployed image is Honcho **v3.x** (`ghcr.io/plastic-labs/honcho:v3.0.9`), whose API is reorganised around workspaces/peers. Every call is wrapped in `try/catch` that returns `[]`/no-ops on failure, so memory **silently stops working** — turns succeed, but twins never persist or recall anything, and nothing reports the degradation.

This feature makes both gaps explicit, fail-loud where they should, and closed.

## Clarifications

### Session 2026-06-07
- **Q: Engine deployment model?** → **Both.** Ship a reproducible engine **container image** (new `packages/api/Dockerfile`, Node + Python, Hermes CLI on PATH) for prod-like one-command deploy, **and** keep a documented/verifiable **host prerequisite** path for local dev (today's venv). (resolves FR-004)
- **Q: Existing Honcho data on v3 cutover?** → **Disposable/fresh.** Honcho is reconstructible from the SoR (spec 010 §c); no data of record lives only there. Start clean on cutover, no data migration. (resolves FR-010)
- **Q: Version pinning?** → **Pin exact.** Hermes `0.15.1`; the Honcho client targets `v3.0.9` (matching the deployed image tag). No floating ranges. (resolves FR-011)
- **Q: Worker/channel Dockerfiles in scope?** → **No.** Engine + Hermes + Honcho memory only; the other three missing Dockerfiles belong to a separate "containerize the stack" feature. (sets scope boundary)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agentic turns actually execute (Priority: P1)

As an **operator** deploying the Twin Engine, when a tenant's twin takes an agentic turn, the turn runs end-to-end instead of crashing because the Hermes runtime is missing.

**Why this priority**: Without a resolvable Hermes CLI, **every** agentic turn dies (`spawn ENOENT`). This is a hard, total blocker for the loop — nothing in spec 010 works. The failure is also invisible until a real user triggers it, which is the worst possible place to discover it.

**Independent Test**: Deploy the stack, send one message that routes to the agentic path, and observe a completed turn (streamed answer, `stopReason: end_turn`). Separately, deliberately break the Hermes runtime and confirm the engine refuses to start (or reports unhealthy) with an actionable error *before* any turn is attempted.

**Acceptance Scenarios**:

1. **Given** a correctly deployed engine runtime, **When** an agentic turn is dispatched, **Then** the engine spawns `hermes acp`, drives the ACP handshake, and the turn completes without a spawn/runtime error.
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
- **FR-004**: The Hermes runtime MUST be provisioned for **both** engine deployment models (CQ1): (a) a reproducible engine **container image** — a new `packages/api/Dockerfile` (Node + Python) that installs the Hermes Python CLI on PATH — for prod-like one-command `compose up`; **and** (b) a **host-process** path — Hermes documented and verifiable as a host prerequisite for local dev.
- **FR-005**: The Honcho client MUST communicate using the API version served by the deployed Honcho image (v3.x), so that working/user-model memory is actually written and retrieved.
- **FR-006**: Honcho memory operations MUST remain non-fatal to a turn when Honcho is unavailable (graceful degradation preserved from current behaviour).
- **FR-007**: Honcho memory degradation/failure MUST be observable — logged AND surfaced via a signal (metric and/or health/readiness indicator) — so a silent no-op cannot ship unnoticed. A permanent API-version mismatch SHOULD be distinguishable from a transient outage.
- **FR-008**: Per-tenant memory isolation MUST hold in the Honcho v3 namespace model — one tenant MUST NOT be able to read another tenant's memory.
- **FR-009**: Honcho MUST remain reconstructible from the engine System of Record — nothing of record may live only in Honcho (portability invariant, spec 010 §c).
- **FR-010**: On cutover to Honcho v3 the existing store is treated as **disposable** (CQ2) — started fresh and rebuilt from the SoR (per FR-009); **no data migration** is required or performed.
- **FR-011**: Hermes version and the Honcho API target MUST be **pinned to exact versions** (CQ3): Hermes `0.15.1`; the Honcho client targets `v3.0.9` (matching the deployed image tag). No floating ranges — a runtime that boots today MUST boot identically tomorrow.

### Key Entities *(include if feature involves data)*

- **Engine Runtime Environment** — the process context (container or host) running `twin-engine-api`/workers; owns PATH and runtime env (`HERMES_ACP_CMD`, `HONCHO_URL`). Today: no container image exists for it.
- **Hermes Agent CLI** — external Python CLI (`hermes_cli`), ACP-capable, spawned process-per-tenant with an isolated `HERMES_HOME`. Not an npm dependency; not a prebuilt binary.
- **Honcho Memory Namespace** — the per-`(tenant, persona[, externalUser])` memory scope; in Honcho v3 expressed via its workspace/peer primitives. Holds working/user-model memory only; never data of record.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh deploy of the standalone stack reaches a state where an agentic turn completes end-to-end (no `ENOENT`, no missing-image build failure) in 100% of smoke runs.
- **SC-002**: A missing or incompatible Hermes runtime is reported at engine startup, before any user turn, with an actionable error — 0 cases where the failure first surfaces to an end-user.
- **SC-003**: A fact written to memory on one turn is retrievable on a subsequent turn (memory round-trip works) — 0% silent no-op when Honcho is healthy.
- **SC-004**: Cross-tenant memory read attempts return nothing belonging to the other tenant in 100% of isolation tests.
- **SC-005**: With Honcho stopped, 100% of agentic turns still complete (degraded, no memory), and the degradation is visible in logs and a health/metric signal.

## Out of Scope

- Full containerisation of the **worker** and **channel** services. Their Dockerfiles are also missing, but this feature is scoped (CQ4) to the **agentic loop runtime** — engine + Hermes + Honcho memory. The three other missing Dockerfiles (document-worker, channel-telegram, channel-whatsapp) belong to a separate "containerize the stack" feature; they are **not** needed for an agentic turn (SC-001).
- Re-architecting Hermes process pooling, BYOK injection, or the MCP tool-gateway (owned by spec 010).
- Honcho feature work beyond API-version compatibility (e.g. dialectic/insight tuning).

## Dependencies & Assumptions

- **Depends on** the standalone-compose image-namespace fix (honcho → `ghcr.io/plastic-labs/honcho:v3.0.9`; removal of the non-existent `nousresearch/hermes-agent` service) — done in the working tree on this branch.
- **Assumes** Honcho v3's API is the workspaces/peers model and differs structurally from the legacy apps/users surface the client uses. *(Confidence ~0.8 — to be verified during planning/research, not yet treated as fact.)*
- **Assumes** `hermes acp` runs headless on the target OS (Linux container or host); the Windows `prompt_toolkit` console issue documented for `hermes chat` does not affect the ACP stdio path (spec 010 §i verified `hermes acp --check` OK).
