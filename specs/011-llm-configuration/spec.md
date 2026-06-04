# Feature Specification: Per-Assistant LLM Provider Configuration (Runtime)

**Feature Branch**: `011-llm-configuration` *(branch/snapshot deferred — no commit without consent)*
**Created**: 2026-06-04
**Status**: Clarified
**Input**: Runtime half of the runtime↔admin split. Product admin (`ai-twins/011-llm-configuration`) lets an operator pick a custom OpenAI-compatible LLM provider (base URL + API key + model id + temperature/max_tokens) per assistant, with a tenant-level default. THIS engine feature owns: storing the config + encrypting the key, **injecting** the effective config into the Hermes executor (010) so the twin actually runs on that provider/model, and **durable-retry** on the reply-path when the configured provider fails.

<!-- Split note: 2026-06-04 — pairs with Product `ai-twins/011-llm-configuration` (thin admin UI/BFF). Same runtime↔admin split family as engine-008↔ai-twins/010-agent-builder-admin, engine-009-reengagement-runtime↔ai-twins/006-reengagement-admin. Engine = system of record + executor + guardrail (DD-HX-001 from 010); Product = UI. This feature extends `008-agent-builder` (persona SoR) with per-assistant provider config and extends `010-hermes-executor` (the spawn/ACP injection point + warm-pool) with effective-config injection + provider-failure durable-retry. -->

## Overview

Today the executor (`010-hermes-executor`) runs every agentic turn on a **pooled self-host `hermes-agent`** via an **ACP session** (010 FR-002), using a **single engine-wide** model/provider config; the thin OpenAI-compatible completion (`packages/core/src/services/llm-client.ts`) survives only as the outage fallback (010 FR-009). Every twin shares the same brain-provider.

This feature makes the LLM provider **per-assistant**, with a **tenant-level default** (resolution: assistant override → tenant default → platform default). The provider is a **BYOK custom OpenAI-compatible endpoint** (base URL + API key + model id + `temperature`/`max_tokens`), configured from the Product admin (`ai-twins/011`), **stored in the engine SoR** (Postgres/Drizzle) with the **key encrypted at rest**, and **injected into the assistant's Hermes turn** so the twin actually runs on the tenant's chosen provider/model. On configured-provider failure the engine **durably retries on the same provider** (no silent model-swap) — which **refines 010 FR-009**.

> **Boundary (DD-HXL-001)**: **Engine owns** the provider-config SoR (Postgres/Drizzle, tenant-scoped, key encrypted at rest), the **injection** of effective config into Hermes (010 ACP session), the **SSRF egress guard** on the user-supplied base URL (the engine is the actual egress sink), the **durable-retry** on provider failure (rides the 009 BullMQ heartbeat), and **metering** (007). **Product (`ai-twins/011`)** = thin admin UI/BFF only. **Hermes** = the executor that receives the injected config. **Guardrails are unchanged**: validators (004) still gate every output regardless of which provider produced it (010 FR-003).

## User Scenarios

### US1 — Per-assistant provider applied on the agentic reply-path (P1) 🎯 MVP
An agentic turn for an assistant with a configured custom provider → engine resolves the **effective** config (assistant override → tenant default → platform default) → injects base URL / key / model / `temperature` / `max_tokens` into the Hermes ACP turn → the twin runs on **that** provider/model → validators (004) gate output → reply persisted + delivered.
**Acceptance**: a turn for an assistant with a custom provider demonstrably runs on that base URL/model (verifiable via trace/metering); an assistant with no override falls to the tenant default, then platform default; cross-tenant key is never used; validators still gate.

### US2 — Durable-retry on provider failure, no model-swap (P1)
The configured provider is unreachable / key invalid / times out at reply-time → engine **enqueues** the turn on the 009 BullMQ queue and **retries on the SAME provider** with backoff → on recovery the turn completes and delivers → retry-window exhausted → **dead-letter + operator alert**. **No silent fallback to the thin-completion path / a different model** for a BYOK provider failure (refines 010 FR-009).
**Acceptance**: 0 lost messages on a transient provider outage; 0 silent model-swaps; queued turns complete after recovery; dead-letter + alert (not silent drop) after the window; a key rotated while turns are queued → retries use the new key.

### US3 — Secret handling + SSRF egress guard (P1)
Engine stores the API key **encrypted at rest**, decrypts it **only at injection time**, never logs/traces/returns it, and never lets one tenant's key cross into another tenant's turn (pooled-process isolation). The user-supplied **base URL** is the real egress sink → engine enforces an allow/deny policy before any outbound call.
**Acceptance**: key absent from logs/traces/error bodies; a base URL pointing at loopback/private/link-local/cloud-metadata is rejected; a pooled/warm Hermes process never executes a turn under another tenant's provider/key.

### US4 — Config lifecycle + pooling coherence (P2)
A config change takes effect on subsequent turns and on queued retries (always the **current** effective config). A pooled/warm Hermes process MUST NOT serve a turn under a **stale** or **foreign** provider config — the same hazard class as the 010 T000d cross-session leak.
**Acceptance**: no turn runs under a stale config after an update; no cross-config bleed in the warm-pool; clearing an assistant override falls back to tenant default, clearing both falls to platform default (defined behavior).

### Edge Cases
- Provider down for the whole retry-window → dead-letter + alert; message not lost, not silently swapped.
- Key rotated mid-queue → subsequent retries use the new key (decrypt at injection, not at enqueue).
- Model id not present at the provider → typed error; test-connection (FR-010) red; on prod path → retry/dead-letter if it never appears.
- base URL → internal network (SSRF) → rejected at the engine (FR-004).
- **Pooled process reuse across providers** → process must be re-pointed to the effective config or routed to a config-matched pool; never reuse a foreign provider/key (FR-008/DD-HXL-002).
- **Hermes executor down but the configured provider is healthy** → 010 FR-009 fallback applies **only** if it does not silently switch the assistant to a *different* provider/model (DD-HXL-003); otherwise durable-retry.
- Per-tenant budget exhausted while retrying (010 FR-008) → in-flight retry finishes, new agentic turns refused.
- BYOK metering: inference $ accrues to the tenant's provider account, not the platform (FR-007).
- Key rotated mid-loop → in-flight turn may fail with the old key; retry (T013) re-resolves the current effective config and decrypts the new key — the turn completes under the updated key, not dead-lettered for a transient rotation.
- KMS unavailable at injection time → turn fails; durable-retry (FR-005) applies — same as provider failure, the turn queues and retries when KMS recovers. KMS health is surfaced in `/v1/health` (degraded). Engine does NOT cache decrypted keys in RAM.
- Platform default = `HERMES_DEFAULT_PROVIDER` / `HERMES_DEFAULT_MODEL` / `HERMES_DEFAULT_BASE_URL` env vars (set at engine deploy time, not per-tenant). If all three are unset, the platform default is the existing engine-wide config (010 single-provider baseline).

## Functional Requirements

- **FR-001**: Engine MUST persist per-assistant and per-tenant-default LLM provider config — `baseUrl`, `modelId`, `apiKey` (**encrypted at rest**), `temperature`, `maxTokens`, `enabled` — in the SoR (Postgres/Drizzle), tenant-scoped (RLS), `1:0..1` with persona (008). Effective config resolves **assistant override → tenant default → platform default**.
- **FR-002**: Engine MUST inject the **effective** provider config into the assistant's Hermes turn (010 ACP session) so the agentic loop runs on that `baseUrl`/`modelId`/`temperature`/`maxTokens`. **Injection mechanism is GATED** (DD-HXL-002): per-session ACP override (if Hermes supports it) vs pool-keyed-by-config vs ephemeral spawn — must be empirically verified before lock (cf. 010 T000a/T000c/T000d gates).
- **FR-003**: The API key MUST be **encrypted at rest** (engine-owned, C3), **decrypted only at injection time**, never logged/traced/returned, and MUST NOT cross a tenant boundary (pooled-process isolation — same hazard as T000d).
- **FR-004**: The user-supplied `baseUrl` egress MUST be **SSRF-guarded** at the engine (reject loopback/private/link-local/cloud-metadata; allow/deny policy) before any outbound call — the engine is the actual egress sink. guard MUST resolve DNS first, then check all resolved IPs (both IPv4 and IPv6) against deny list. HTTP redirects on egress client MUST be disabled.
- **FR-005**: On configured-provider failure (unreachable/auth/timeout) on the **prod reply-path** → **durable-retry on the SAME provider** via the 009 BullMQ queue (exponential backoff, configurable retry-window); **no silent thin-completion model-swap** for BYOK provider failures (refines 010 FR-009, DD-HXL-003); window exhausted → **dead-letter + operator alert**. *(Interactive sandbox turns from Product 010 are synchronous: typed error + manual retry, no queue.)*
- **FR-006**: Guardrails are **unchanged**: validators (004) gate every output regardless of provider; tool sandbox, 009 anti-spam, and metering still apply (010 FR-003/006/007/008). A custom provider MUST NOT bypass any guardrail.
- **FR-007**: **Metering** — BYOK turns MUST still emit token usage to OpenMeter (007) for loop/token caps + per-tenant budget + observability, flagged as **BYOK** (inference $ accrues to the tenant's provider account, not the platform). *(Confirmed in Clarify.)*
- **FR-008**: A config change MUST take effect on subsequent turns **and** on queued retries (always the current effective config); warm-pool / pooled processes MUST NOT serve a turn under a **stale** or **foreign** provider config (pooling coherence, DD-HXL-002).
- **FR-009**: **Path scope** — the per-assistant provider config MUST govern the assistant's LLM call on **both** the agentic (Hermes) path **and** the thin-completion path when that path serves the same assistant, so a fallback never silently drifts to a different provider/model. *(Confirmed in Clarify.)*
- **FR-010**: Engine MUST expose a **test-connection** check (provider reachability: auth + model availability) for the Product admin (`ai-twins/011` FR-007), returning a typed success/failure **without** leaking the key or the raw upstream body.
- **FR-011**: **Observability** — provider-config changes, provider failures, retries, and dead-letters MUST emit audit/trace events (010 FR-011 audit + Langfuse spans) with secrets **redacted**.

## Clarifications

### Session 2026-06-04
- **Q: Injection into the pooled ACP warm-pool? → A:** per-session ACP model/provider override **if** verified (gate **T000-LLM**), **else** pool keyed by provider-config; ephemeral-per-turn **rejected** (collapses warm-pool, breaks 010 p95 latency budget) → **DD-HXL-002**, FR-002/FR-008.
- **Q: Does the per-assistant provider govern both LLM paths? → A:** **both** the agentic (Hermes) and thin-completion paths — a fallback never drifts to a different provider/model → **FR-009**.
- **Q: Meter BYOK turns in OpenMeter? → A:** **yes**, with a BYOK flag — tokens metered for loop/token caps + budget + observability; inference $ on the tenant's provider account (platform $ = 0); no platform fee in MVP → **FR-007**, **DD-HXL-004**.

- **DD-HXL-001 (SoR = Engine)** → provider config + encrypted key live in the engine SoR (Postgres/Drizzle), tenant-scoped, `1:0..1` with persona (008); Product is a thin UI. Mirrors 010 DD-HX-001 (engine owns data/keys).
- **DD-HXL-002 (injection mechanism — RESOLVED: primary A → fallback B; gated)** → because Hermes runs via **pooled ACP sessions on a warm-pool** (010 FR-002/FR-005), per-assistant config cannot be baked into a persistent profile of a *shared* process. **Primary (A)**: per-session ACP model/provider override — **conditional on gate T000-LLM** (does Hermes `session/new` accept a per-session model/provider override?). **Fallback (B)**: pool **keyed by provider-config** (one warm process per distinct config; reuse by config, not by assistant — bounded, since few distinct providers per deployment). **Rejected (C)**: ephemeral spawn per turn — it collapses the 010 warm-pool and blows the p95 latency budget. **Pooling coherence (FR-008)**: under either A or B, a pooled/warm process MUST NEVER serve a turn under a stale or foreign provider config (same hazard class as T000d).
- **DD-HXL-003 (durable-retry refines 010 FR-009)** → a BYOK custom-provider failure → durable-retry on the **same** provider, **not** a silent thin-completion model-swap; 010 FR-009 thin-completion fallback is reserved for **executor (Hermes process)** outages where switching the assistant's *provider/model* is not implied. No drift to platform default for BYOK failures.
- **DD-HXL-004 (BYOK metering — RESOLVED)** → meter to OpenMeter (loop/token caps + budget + observability) with a **BYOK flag**; inference $ accrues to the tenant's provider account (platform $ = 0); **no platform fee in MVP** (FR-007).
- **DD-HXL-005 (guardrails unchanged)** → validators (004) + sandbox + anti-spam + metering apply to every turn regardless of provider; no provider can bypass the gate (010 FR-003).

## Non-Functional

- **Isolation (CRITICAL)**: per-tenant key never crosses tenants in the pool; provider config is tenant-scoped (RLS); pooled-process reuse never bleeds provider/key across `(tenant, assistant)` — same class as the 010 T000d finding. → [SEC] E2E.
- **Secrets**: API key encrypted at rest (engine-owned), decrypted only at injection, never in logs/traces/errors/Product responses (Standing Order 4; 010 "engine owns keys").
- **SSRF/egress-safety**: user-supplied base URL is a deliberate egress sink → allow/deny enforcement at the engine; no path into the internal network. → [SEC] test.
- **Reliability**: no message loss on provider outage — durable-retry to recovery or dead-letter+alert; durable state never only in agent RAM (010 NFR).
- **Performance**: injection MUST preserve the 010 warm-pool latency budget (p95 ≤ ~8 s warm / ≤ ~20 s cold); the chosen pooling strategy (DD-HXL-002) must not collapse warm reuse for common configs.
- **Observability**: Langfuse spans for provider selection + failures + retries; audit for config changes; secrets redacted.

## Success Criteria

- **SC-001**: an assistant with a configured custom provider runs its agentic turns on **that** provider/model — 0 drift vs configured (verifiable via trace/metering).
- **SC-002**: 0 cross-tenant key/provider use under concurrency in the pool (security test).
- **SC-003**: 0 API key occurrences in logs/traces/error bodies/Product responses (security test).
- **SC-004**: 0 lost messages on a transient provider outage — queued turns complete after recovery; dead-letter + alert (never silent drop) after the retry-window.
- **SC-005**: 100% of SSRF base-URL attempts (loopback/private/link-local/metadata) blocked.
- **SC-006**: warm-pool latency budget (010) held within tolerance after the injection mechanism lands.

## Glossary

- **Effective config** — result of resolving `assistant override → tenant default → platform default` (FR-001).
- **BYOK** — bring-your-own-key: tenant supplies the provider creds; inference $ accrues to the tenant's provider account.
- **Injection** — applying the effective provider config (base URL / key / model / params) to the assistant's Hermes ACP turn (FR-002, DD-HXL-002).
- **Durable-retry / dead-letter** — provider-failure turns are queued (009 BullMQ), retried on the same provider to recovery, or dead-lettered + alerted after the window (FR-005).
- **Executor** — Hermes (010), the pooled agentic backend that receives the injected config.
- **Guardrail gate** — validators (004) + anti-spam (009) + tool sandbox + metering, applied to every turn regardless of provider (010 DD-HX-001).
- **Durable-retry** — automatic re-execution of a failed turn on the same provider via BullMQ queue with exponential backoff (FR-005).
- **Dead-letter** — terminal state after the retry window is exhausted; operator is alerted, message is preserved but not retried further (FR-005).
- **Platform default** — the engine-wide LLM provider/model configured via `HERMES_DEFAULT_*` environment variables at deploy time; used when neither an assistant override nor a tenant default is set (FR-001).

## Out of Scope

- **The admin UI/BFF** — Product `ai-twins/011-llm-configuration` (consumer).
- **HOW the key is encrypted** (KMS vs envelope vs pgcrypto), exact queue tuning (backoff/window/max-attempts numbers), exact pooling implementation — `plan.md`.
- **Empirical capability verification** of ACP per-session model override — a pre-implementation gate (T000-LLM), resolved in plan/tasks, not here.
- **Multi-provider fallback chains / load-balancing / credential pools** (Hermes `fallback_providers` / `credential_pool_strategies`) — future.
- **Curated provider presets** and **non-OpenAI-dialect adapters** — future (Product 011 DD-LLM-004: Custom OpenAI-compatible only in MVP).
- **Full model-param surface** beyond `temperature`/`max_tokens` (`context_length`/`top_p`/penalties) — future.
- Re-specifying 008 persona internals or 010 executor internals — those specs own them.

## Dependencies

- **`008-agent-builder`** — persona = SoR anchor; provider config is `1:0..1` with persona. **Gate**: exact storage shape (new entity vs persona columns) finalized in `data-model.md`.
- **`010-hermes-executor`** — the **injection point**: ACP session + warm-pool + pooling. This feature extends it with effective-config injection + provider-failure durable-retry + the 010 FR-009 refinement (DD-HXL-003). **Gate**: ACP per-session override capability (T000-LLM) drives DD-HXL-002.
- **`009-reengagement-runtime`** (BullMQ scheduler) — the durable-retry rides this queue/heartbeat (010 FR-006).
- **`004-validators`** — outbound gate, unchanged; applies to custom-provider output too (DD-HXL-005).
- **`007` / OpenMeter + KMS** — metering for caps/budget (FR-007); key-encryption substrate (KMS) for FR-003.
- **`ai-twins/011-llm-configuration`** (Product) — the consumer admin/BFF; this engine feature serves its `GET/PUT` config + `test-connection` endpoints.
- **Hermes (Nous `hermes-agent`, self-host C3)** — receives the injected config; `model.provider: custom` + `base_url` + key + `temperature`/`max_tokens` = OpenAI-compatible (docs-confirmed). **Open**: does ACP `session/new` accept per-session model/provider override? → gate T000-LLM (DD-HXL-002).
