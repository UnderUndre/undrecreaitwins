---
description: "Task list — Per-Assistant LLM Provider Configuration (Runtime / engine)"
---

# Tasks: Per-Assistant LLM Provider Configuration (Runtime)

**Input**: Design documents from `specs/011-llm-configuration/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/llm-provider.contract.md
**Tests**: spec NFR-6 requires E2E on the critical path → [E2E] included; security NFRs → [SEC] included.

## Phase 1: Setup

- [x] T001 [SETUP] Scaffold `packages/core/src/services/llm-provider/` (provider-config.service, resolution, crypto, ssrf-guard, test-connection) + `services/retry/provider-retry.worker.ts` stub + internal API route stubs, per plan.md §structure
- [x] T002 [OPS] Configure env/bindings (no secrets in repo): KMS envelope binding (007), BullMQ queue `llm-provider-retry`, SSRF allow/deny policy — document in `infra/.env.example`

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ Sync barrier — no user-story work until done. Includes the empirical gate.**

- [x] T003 [BE] **Gate T000-LLM — PASSED 2026-06-04: the BYOK provider is actually CONSUMED by Hermes.** *(Earlier the shipped adapter injected dead `HERMES_BASE_URL/HERMES_API_KEY/HERMES_MODEL_ID` env names → silent no-op; corrected to HERMES_HOME profile + config.yaml + `OPENAI_API_KEY`.)* **Evidence:**
    1. ✅ `rg "HERMES_BASE_URL|HERMES_API_KEY|HERMES_MODEL_ID" <hermes-agent>` → hits ONLY in shell-tool env-passthrough, NOT the model loader.
    2. ✅ `HERMES_HOME=<profile>` (config.yaml `model.{provider:custom,base_url,default}`) + `hermes -z` one-shot → **capture proxy received `POST /v1/chat/completions model=gate-test-model`** at the configured `base_url` (NOT the `~/.hermes` default); `hermes config show` reflects the injected model.
    3. ✅ **Model-only `config.yaml` is sufficient** (Hermes probes `/v1/models` then completes; no extra keys needed).
    4. ⚠️ OPEN (small follow-up): `temperature` field placement in Hermes config not yet confirmed/wired — adapter writes `max_tokens` (docs-valid), `temperature` unwired.
   Strategy **B locked** (HERMES_HOME profile). ACP per-session override (A) not needed — B verified end-to-end.
- [x] T003b [BE] **(Conditional — if T003 = Strategy B)** Pool-keyed-by-config warm-pool manager: hash effective config → pool key; `MAX_DISTINCT_CONFIGS_PER_TENANT = 8` (env-tunable); LRU eviction on idle TTL (15 min); rejection on save if limit reached. Gated by T003 outcome. **Blocks T010 if Strategy B.**
- [x] T004 [DB] Drizzle schema `llm_provider_config` + `tenant_llm_default` (data-model.md) with `UNIQUE(personaId)`/`UNIQUE(tenantId)`, `version` optimistic-lock col; generate reviewable migration `.sql` (no direct apply — Standing Order 5)
- [x] T005 [BE] Crypto module `crypto.ts` — KMS-envelope encrypt/decrypt, decrypt-only-at-injection (research D2), typed errors (KMS failure triggers BullMQ retry), no plaintext logging
- [x] T006 [BE] SSRF guard `ssrf-guard.ts` — reject loopback/private/link-local/cloud-metadata + **DNS-resolve-and-pin** (resolve IP, check CIDR, connect via pinned IP with Host/SNI header), with unit tests
- [x] T007 [BE] Resolution `resolution.ts` — `effective(tenant, persona) = override → tenantDefault → platformDefault` (data-model §resolution) with unit tests

**Checkpoint**: schema + crypto + SSRF + resolution + injection-strategy decided → stories can begin

---

## Phase 3: User Story 1 - Per-assistant provider applied on reply-path (P1) 🎯 MVP

**Goal**: operator-configured custom provider is stored (key encrypted) and the assistant's agentic + thin-completion turns actually run on it.
**Independent Test**: set an override → run a turn → trace/metering shows the configured `baseUrl`/`modelId`; validators still gate.

- [X] T008 [BE] [US1] Provider-config service `provider-config.service.ts` — upsert/get/delete tenant-default + assistant-override, **write-only** key (encrypt via T005), optimistic-lock, typed inputs/outputs
- [X] T009 [BE] [US1] Internal API GET/PUT/DELETE config (tenant + assistant), contracts §A, with Zod validation + structured errors + masked key (never return plaintext)
- [X] T010 [BE] [US1] Inject effective config into Hermes executor (`hermes-executor.ts`/`hermes-adapter.ts`) via Strategy A or B (per T003) + coherence assertion (research D3) + metering `byok` tag (D6)
- [X] T011 [BE] [US1] Extend thin-completion path (`llm-client.ts`) to honor the same assistant's effective config (FR-009 — no provider drift on fallback)
- [X] T012 [BE] [US1] test-connection service+endpoint (`test-connection.ts`, contracts §A) — typed `ok/reason`, rate-limited, no key/raw-upstream leak. **Key merge**: if `apiKey` is omitted in the request, merge with stored decrypted key for testing effective state.

**Checkpoint**: MVP — configure + inject + apply works end-to-end

---

## Phase 4: User Story 2 - Durable-retry, no model-swap (P1) — ⚠️ DEFERRED → `followup-Y-durable-retry.md`

> **DESCOPED from 011 MVP (2026-06-04).** `provider-retry.worker.ts` compiles but is **orphaned scaffolding** — nothing enqueues/starts it, and it has **no outbound delivery** (a retried answer is only logged, never sent to the user). Wiring it as-is would **regress** the 010 thin-completion fallback (degraded-answer-now → no-answer-ever). US2 ("no message loss") does **NOT** work; it is split into the **Y follow-up** (`followup-Y-durable-retry.md`). 011 MVP ships on the verified injection core (US1, gate T003 PASSED).

**Goal (Y)**: provider outage on the prod path never loses a message and never silently swaps model.
**Independent Test (Y)**: break the provider → turn enqueues + retries same provider; restore → completes **and delivers**; exhaust window → dead-letter + alert.

- [ ] T013 [BE] [US2] **DEFERRED (Y)** — BullMQ `provider-retry.worker.ts` worker logic exists (backoff/dead-letter/re-resolve) but is ORPHANED: not enqueued, not started, no delivery-on-success. See `followup-Y-durable-retry.md`.
- [ ] T014 [BE] [US2] **DEFERRED (Y)** — dead-letter + operator-alert wiring; sandbox stays synchronous. Blocked on the Y delivery work.

**Checkpoint (Y)**: zero message loss, zero silent model-swap — *not met in 011 MVP (deferred)*.

---

## Phase 5: User Story 3 - Secret handling + SSRF (P1)

**Goal**: key never leaks/crosses tenants; user-supplied base URL can't reach the internal network.
**Independent Test**: grep logs/traces for key → zero; SSRF base_url → blocked; concurrent tenants → no cross-tenant key use.

- [X] T015 [SEC] [US3] Secret-handling audit — key absent from logs/traces/error bodies/audit; decrypt-only-at-injection enforced; Langfuse/audit redaction (FR-011)
- [X] T016 [SEC] [US3] SSRF + cross-tenant isolation audit — egress guard effective incl. DNS-rebind (via pinned IP); pooled-process key/config isolation (research D3); no foreign/stale config served

---

## Phase 6: User Story 4 - Lifecycle + pooling coherence (P2)

**Goal**: config changes apply to next turns + queued retries; pooled processes never serve stale/foreign config.
**Independent Test**: update config mid-flight → next turn uses new; clear override → default → platform.

- [X] T017 [BE] [US4] Config-change propagation — subsequent turns + queued retries use current effective config; clear-override→default, clear-both→platform (FR-011)
- [X] T018 [BE] [US4] Pooling-coherence enforcement — hard assertion a pooled/warm process never serves a stale/foreign provider config (research D3) under Strategy A/B; **Idle TTL eviction** + MAX_DISTINCT_CONFIGS limit (T003b if Strategy B)

---

## Phase 7: Polish & Cross-Cutting

- [ ] T019 [E2E] Integration suite — provider parity, durable-retry no-loss + dead-letter, cross-tenant isolation, SSRF block (NFR-6) in `packages/core` integration tests
- [ ] T020 [PERF] Warm-pool latency budget check post-injection (010 p95 ≤ ~8 s warm) for the chosen strategy
- [ ] T021 [DOC] Update contracts/quickstart + add 011 reference row to `specs/main/architecture.md` (apply on consent — file currently has uncommitted 010 changes)
