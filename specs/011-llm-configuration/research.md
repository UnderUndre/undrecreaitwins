# Research: Per-Assistant LLM Provider Configuration (Runtime)

Phase 0 — resolve unknowns from Technical Context. Decisions feed data-model, contracts, tasks.

## D1 — Hermes ACP per-session model/provider override (GATE T000-LLM) 🔬

**Decision**: Treat as an **empirical gate** before locking the injection strategy — same discipline as 010 T000a/T000c/T000d. Spike: open an ACP `session/new` against a pooled `hermes-agent` and attempt a per-session model/provider/base_url override; observe whether it takes effect without restarting the process.

**Rationale**: Hermes docs confirm `model.provider: custom` + `base_url` + key + `temperature`/`max_tokens` at config/CLI level, and a `/model` per-session command in interactive mode, but are **silent on ACP/headless per-session override**. The whole injection design forks on this answer; guessing risks a rebuild.

**Outcome routing**:
- **Gate PASS** → **Strategy A**: per-session ACP override on a shared warm process (cleanest; warm-pool preserved).
- **Gate FAIL** → **Strategy B**: pool **keyed by provider-config** (one warm process per distinct config; reuse by config). Bounded — few distinct providers per deployment.
- **Rejected — Strategy C**: ephemeral spawn per turn (env injection). Collapses warm-pool → blows p95 budget (010 NFR). Last resort only.

**Alternatives considered**: persistent Hermes profile-per-assistant (`HERMES_HOME=~/.hermes/profiles/<assistantId>`) — rejected: thousands of stateful home dirs in multi-tenant SaaS, lifecycle/GC burden, and the T000d cross-session-state hazard. Profile-per-**config** collapses into Strategy B if needed.

## D2 — API key encryption at rest

**Decision**: **Envelope encryption** — a KMS-managed key-encryption-key (007) wraps a per-record data key; ciphertext + key reference stored in Postgres; **decrypt only at injection time** in `services/llm-provider/crypto.ts`. Never log/trace plaintext.

**Rationale**: engine "owns data/keys" (010 C3). Envelope keeps plaintext out of the DB and lets keys rotate without re-encrypting rows. Decrypt-at-injection minimizes plaintext lifetime in memory.

**Alternatives**: pgcrypto column encryption (rejected — key material near the DB; weaker blast-radius story); plaintext+disk-encryption only (rejected — fails NFR-2 / Standing Order 4); external Vault dynamic secrets (heavier ops; revisit post-MVP).

**Open (→ plan/impl)**: exact KMS provider/binding from 007 — flagged, not blocking the data-model.

## D3 — Pooling coherence (no stale/foreign config) 🔒

**Decision**: Under **either** strategy, a turn carries its **resolved effective config** explicitly; a pooled/warm process MUST be (A) re-pointed per session or (B) selected from the config-matched pool. Add an assertion: the config used by a turn == the resolved config for `(tenant, assistant)`; mismatch → hard error, never serve.

**Rationale**: directly mitigates the T000d cross-session leak class — the dominant security risk of sharing processes across tenants/providers.

## D4 — Durable-retry on provider failure (refines 010 FR-009)

**Decision**: On configured-provider failure (unreachable/auth/timeout) on the **prod reply-path**, enqueue a retry job on the **009 BullMQ** queue: exponential backoff, configurable `maxRetryWindow`/`maxAttempts`, retry **the same provider**; on success deliver via the normal channel; on window exhaustion → **dead-letter queue + operator alert**. **No silent thin-completion model-swap** for a BYOK provider failure. 010 FR-009 thin-completion fallback is reserved for **executor (Hermes process)** outages where the assistant's provider/model is not silently changed.

**Rationale**: honors the user's "hard-fail + retry, no fallback" decision (Product 011 + DD-HXL-003); reuses existing 009 infra (no new queue). Sandbox/interactive turns (Product 010) stay synchronous: typed error + manual retry, no queue.

**Alternatives**: keep 010 FR-009 as-is (rejected — silently swaps model/provider/cost, the exact drift the user rejected); fast-retry-then-fallback (rejected for BYOK — still drifts).

**Defaults (tunable, → plan)**: backoff 5 s → cap ~2 min; window ~30 min or N≈8 attempts; then dead-letter + alert.

## D5 — SSRF egress guard on base_url 🔒

**Decision**: Validate + pin at the engine before any outbound call: reject non-https, loopback, RFC1918 private, link-local, and cloud-metadata (`169.254.169.254`, etc.); resolve DNS and **pin the resolved IP** for the request to defeat DNS-rebind; optional per-tenant allowlist. Enforced in `services/llm-provider/ssrf-guard.ts` and applied on both config-save (test-connection) and every reply-time call.

**Rationale**: the engine is the real egress sink for a user-supplied URL — classic SSRF. Defense-in-depth with the Product BFF's own check (ai-twins 011 FR-004).

## D6 — Metering for BYOK

**Decision**: Emit token usage to OpenMeter (007) for every BYOK turn with a `byok=true` flag; loop/token caps + per-tenant budget still enforced (010 FR-008); inference $ attributed to the tenant's provider account, platform $ = 0; **no platform fee in MVP**.

**Rationale**: keeps caps + observability intact without double-charging; clean attribution.

## Resolved unknowns → Technical Context

| Unknown | Resolution |
|---|---|
| ACP per-session override? | Gate T000-LLM → A (pass) / B (fail); C rejected |
| Key encryption substrate | KMS-envelope (007), decrypt at injection |
| Pooling vs per-assistant config | Strategy A/B + coherence assertion (D3) |
| Provider-failure behavior | BullMQ durable-retry, no model-swap (D4) |
| SSRF | engine egress guard + DNS-pin (D5) |
| BYOK metering | OpenMeter + `byok` flag (D6) |
