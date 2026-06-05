# Feature Specification: Public OpenAI-Compatible Endpoint per Assistant (Runtime)

**Feature Branch**: `012-openai-endpoint` *(branch/snapshot deferred — no commit without consent)*
**Created**: 2026-06-05
**Status**: Clarified
**Input**: Expose assistants over a **public, API-key-authed OpenAI-compatible endpoint** so they can be driven from any OpenAI client (LibreChat / OpenWebUI / etc.) for testing — and later embedded into client sites. **Per-workspace API key**; the OpenAI `model` field selects the assistant (`asst_<slug>`); a per-key `test`/`live` flag controls prod side-effects. Key-management UI lives in the Product (`ai-twins/012`).

<!-- Split note: 2026-06-05 — RUNTIME half. Pairs with Product `ai-twins/012-openai-endpoint` (key-management admin UI/BFF). Same runtime↔admin split as 010, 011. The engine ALREADY exposes `/v1/chat/completions` (`packages/api/src/routes/chat-completions.ts` → `ChatService.complete`/`completeStream`) where `model` is used as the **persona slug** and tenancy comes from the internal server-to-server Bearer. 012 layers a **public API-key auth scheme** + `/v1/models` + a per-key `test`/`live` mode over that existing reply-path — it does NOT change the reply-path, persona resolution, RAG, few-shot, or the 011 BYOK provider. -->

## Overview

The engine already speaks the OpenAI chat-completions dialect at `/v1/chat/completions` (streaming + non-streaming), resolving the assistant from the `model` field (= persona slug) and the tenant from an internal Bearer. **This feature makes that surface usable by external OpenAI clients**: a **per-workspace API key** authenticates the request (a scheme distinct from the internal server-to-server Bearer), a new **`GET /v1/models`** lists the workspace's assistants as OpenAI models (`id = asst_<slug>`) so a client's model dropdown is populated, and a per-key **`test`/`live` flag** decides whether the turn runs with prod side-effects suppressed (`isTestThread`, like the sandbox) or with full behavior (for client-site embedding later). Keys are the **system of record in the engine** (hashed at rest); the Product owns the management UI.

> **Boundary (DD-OE-001)**: **Engine owns** the public API-key store (hashed), the key-auth middleware, `/v1/models`, `model = asst_<slug>` → assistant resolution within the key's workspace, the `test`/`live` mode enforcement, per-key rate-limit + metering. **Product (`ai-twins/012`)** owns the key-management UI/BFF. The **reply-path is reused unchanged** (persona + RAG (005) + few-shot (008) + the assistant's 011 BYOK provider + validators (004) gate); 012 is an **entry point + auth/mode layer**, not a reply-path change.

## User Scenarios

### US1 — Drive an assistant from an OpenAI client (P1) 🎯 MVP
With a workspace API key configured in an OpenAI client (LibreChat / OpenWebUI / `openai` SDK / curl): `GET /v1/models` returns the workspace's assistants as models (`asst_<slug>`); `POST /v1/chat/completions` with `model=asst_<slug>` runs that assistant's real reply-path and returns an OpenAI-shaped response (streaming + non-streaming).
**Acceptance**: a stock OpenAI client connects with only `base_url` + the key; its model dropdown shows the workspace assistants; a chat produces the assistant's real reply (same persona/RAG/few-shot/provider as prod); an unknown or foreign `model` → `404 model_not_found`.

### US2 — Test vs live mode per key (P1)
A key flagged `test` runs the turn with `isTestThread` — prod side-effects (CRM writes, billing/metering of prod usage, re-engagement) suppressed (reuses the sandbox mechanism). A key flagged `live` runs full behavior (for client-site embedding).
**Acceptance**: a `test` key → 0 prod side-effects; a `live` key → real behavior; the mode is bound to the key, not client-supplied.

### US3 — Key lifecycle + isolation (P1)
Keys are **workspace-scoped**, stored **hashed at rest**, shown once on creation, and rotate/revoke takes effect immediately. A key can only reach its own workspace's assistants.
**Acceptance**: key plaintext never retrievable after creation; revoked key → `401` immediately; a key from workspace A cannot list or call workspace B's assistants; per-key rate-limit enforced.

### US4 — Usage + observability (P2)
Per-key usage is metered (OpenMeter, 007) and traceable (Langfuse), distinguishing `test` from `live`.
**Acceptance**: a call attributable to its key + workspace + assistant + mode; metering emitted (live billable; test flagged non-billable).

### Edge Cases
- Unknown `model` / `asst_<slug>` not in the key's workspace → `404 model_not_found`.
- Invalid/revoked/expired key → `401`.
- Per-key rate-limit exceeded → `429` (OpenAI-shaped).
- Streaming client disconnect mid-stream → abort (existing backpressure/abort path).
- `test` key but the assistant has real-action tools → actions suppressed (isTestThread), not executed.
- Client sends a huge message history → existing chunking/backpressure applies.
- Key with the `model` field omitted/empty → `400` (OpenAI clients always send a model).

## Functional Requirements

- **FR-001**: Engine MUST expose **`GET /v1/models`** authenticated by a workspace API key, returning the key's workspace assistants as OpenAI `model` objects with `id = asst_<slug>` (stable slug, not raw UUID, not display name).
- **FR-002**: `POST /v1/chat/completions` MUST accept a **workspace API key** (`Authorization: Bearer <key>`), resolve `model = asst_<slug>` → the assistant (persona) **within the key's workspace**, run the existing reply-path (stream + non-stream), and return OpenAI-shaped output. Unknown/foreign `model` → `404 model_not_found`.
- **FR-003**: API keys MUST be **workspace-scoped**, **hashed at rest** (never retrievable as plaintext after creation), carry an identifying **prefix**, a **`test`/`live`** flag, an optional **expiry**, and an enabled/revoked state. Rotation/revocation is **effective immediately**.
- **FR-004**: A **`test`** key MUST run the turn with **`isTestThread`** (prod side-effects suppressed — reuses the sandbox/010 gating); a **`live`** key runs full behavior. The mode is bound to the **key**, never client-supplied.
- **FR-005**: The public API-key auth MUST be a **distinct scheme** from the internal server-to-server Bearer; a workspace key reaches **only** its own workspace's assistants (tenant isolation derived from the key, never from a client-supplied tenant id).
- **FR-006**: Per-key **rate-limit** + **usage metering** (OpenMeter 007) MUST apply to both modes. **Live-key hardening** (origin-allowlist, stricter public-surface abuse posture) is **deferred** — until then `live` is rate-limited like `test`, and `test` is the supported mode for external use. *(Numbers → plan.)*
- **FR-007**: Errors MUST be **OpenAI-shaped** (`{ error: { code, message, type } }`); never leak internal stack/raw upstream body/secrets. Invalid key → `401`; rate-limit → `429`; unknown model → `404`.
- **FR-008**: Guardrails + reply-path **unchanged**: validators (004) gate every output; the assistant's persona + RAG (005) + few-shot (008) + its **011 BYOK provider** apply as in prod. 012 is an entry point, not a reply-path change.
- **FR-009**: `/v1/models` MUST list **all** the workspace's assistants (`asst_<slug>`). No per-assistant "expose via API" flag in MVP; selective exposure is a follow-up if public/live embedding later needs it.
- **FR-010**: Each 012 call MUST be **fully persisted** like the prod reply-path — conversation + Honcho memory + metering (007) + Langfuse trace; `test`-key calls persist but are **flagged test** (non-billable, isolated from prod analytics). *(Impl note for plan: OpenAI clients are stateless and resend the full history each call — the engine appends/dedups against the persisted conversation rather than duplicating; the conversation-threading key (e.g. derived from the client/session) is a plan detail.)*

## Clarifications

### Session 2026-06-05
- **DD-OE-001 (SoR = Engine)** → public API-key store (hashed) + endpoint + model→assistant resolution + mode enforcement live in the engine; Product = key-mgmt UI. Mirrors 010/011 split.
- **Q: Key granularity? → A:** **per-workspace** key; `/v1/models` lists the workspace's assistants; the OpenAI `model` field selects the assistant (FR-001/FR-002).
- **Q: Mode / side-effects? → A:** **`test`/`live` flag on the key**; `test` → `isTestThread` (prod side-effects suppressed); `live` → full behavior (FR-004).
- **Q: `model` id form? → A:** **`asst_<slug>`** (stable, readable; not raw UUID, not display name) (FR-001/FR-002).
- **Q: `/v1/models` scope? → A:** **all** workspace assistants (no expose-flag in MVP) → FR-009.
- **Q: persistence? → A:** **full** — conversation + Honcho memory + metering + Langfuse trace; `test` calls flagged test → FR-010.
- **Q: live-key hardening? → A:** **deferred** — MVP enforces per-key rate-limit for both modes; origin-allowlist + public-surface hardening for `live` = follow-up (use `test` keys for external clients until then) → FR-006.
- **DD-OE-003 (key expiry)** → optional, default **no-expiry**; revoke is the immediate kill-switch (FR-003).

## Non-Functional

- **Isolation (CRITICAL)**: a workspace key reaches only its workspace's assistants; no cross-tenant model listing or invocation. → [SEC] E2E.
- **Secrets**: API keys hashed at rest, never logged/returned after creation; prefix-only in logs.
- **OpenAI compatibility**: works with stock clients (LibreChat, OpenWebUI, `openai` SDK) using only `base_url` + key — `/v1/models` + `/v1/chat/completions` (stream + non-stream) shaped per the OpenAI dialect.
- **Reliability**: OpenAI-shaped errors, no crash on bad input / provider failure (011 behavior applies); stream abort handled.
- **Abuse / rate-limit**: per-key limits; `live` (public) surface hardened against enumeration/scraping/cost-abuse.
- **Observability**: per-key + per-mode metering (007) + Langfuse trace; key attributable.
- **Testability**: critical path (external client lists models + chats; test-mode side-effect gating; cross-workspace denial; key revoke) covered E2E.

## Success Criteria

- **SC-001**: a stock OpenAI client (e.g. LibreChat) connects with only `base_url` + a workspace key, sees the workspace assistants in its model dropdown, and gets a real assistant reply — in **< 5 min** of setup, no code.
- **SC-002**: **0** cross-workspace access (a key never lists or calls another tenant's assistant) in a security test.
- **SC-003**: **0** key-plaintext exposure after creation (security test).
- **SC-004**: a `test` key produces **0** prod side-effects; a `live` key produces real behavior — verifiable.
- **SC-005**: replies via 012 match the prod reply-path (same persona/RAG/few-shot/provider) — **0** behavioral drift vs the sandbox/prod for the same assistant.

## Glossary

- **Workspace API key** — the downstream access credential an external OpenAI client uses; workspace-scoped, hashed, `test`/`live`. *(Distinct from the 011 BYOK key, which is the upstream provider credential.)*
- **`asst_<slug>`** — the OpenAI `model` id form that selects an assistant (persona slug).
- **test / live** — per-key mode: test → `isTestThread` (side-effects suppressed); live → full behavior.
- **Reply-path** — the existing `ChatService.complete`/`completeStream` (persona + RAG + few-shot + 011 provider + validators gate). Reused unchanged.

## Out of Scope

- **Key-management UI** — Product `ai-twins/012-openai-endpoint` (consumer).
- Reply-path internals (persona/RAG/few-shot/provider/validators) — 001/003/004/005/008/010/011.
- Billing/usage **screens** — 007 (012 only emits metering).
- Non-chat OpenAI endpoints (`/v1/embeddings`, legacy `/v1/completions`, assistants/threads API) — future.
- Client-site **embed widget** (the JS bubble) — a Product concern; 012 provides the key + endpoint it calls.
- Durable-retry / provider-outage behavior — inherited from 011 (deferred there).

## Dependencies

- **Existing `/v1/chat/completions`** (`chat-completions.ts` → `ChatService.complete`/`completeStream`) — the surface 012 wraps; `model` already = persona slug, streaming already supported.
- **Sandbox / `isTestThread`** (010) — reused for `test`-mode side-effect gating.
- **011-llm-configuration** — each assistant runs on its resolved BYOK provider; 012 doesn't change it.
- **004-validators** — outbound gate, unchanged.
- **007 / OpenMeter + auth substrate** — metering + the workspace/tenant model the keys attach to.
- **`ai-twins/012-openai-endpoint`** (Product) — the key-management UI/BFF consumer.
