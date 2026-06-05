# Research: Per-Assistant LLM Provider Configuration (Runtime)

Phase 0 — resolve unknowns from Technical Context. Decisions feed data-model, contracts, tasks.

## D1 — How the BYOK provider reaches Hermes (GATE T000-LLM) 🔬 — RESOLVED (Strategy B, verified mechanism)

**Decision**: Inject per-spawn via a **throwaway Hermes profile**. The ACP adapter `mkdtempSync`'s a temp dir, writes a minimal `config.yaml` (`model.{provider:custom, base_url, default}`), points **`HERMES_HOME`** at it, and passes the key via **`OPENAI_API_KEY`** env (never written to disk); cleaned in `kill()`. The warm-pool keys by configHash (Strategy B). Implemented in `hermes-adapter.ts` + `hermes-executor.ts` (2026-06-04).

**Why NOT ad-hoc env vars (corrects the first implementation)**: the shipped code injected `HERMES_BASE_URL`/`HERMES_API_KEY`/`HERMES_MODEL_ID` — **Hermes' model loader does not read those**. Verified 2026-06-04 against hermes-agent v0.15.1 source: those names appear ONLY in shell-tool env-passthrough; provider/base_url/api_key are resolved from `config.yaml` `model.*` + `OPENAI_API_KEY` (`acp_adapter/server.py:1895`, `auxiliary_client.py:1289`, `acp_adapter/auth.py:23`). Ad-hoc names = **silent no-op** (Hermes falls back to `~/.hermes/config.yaml`). `config.yaml model.{default,provider,base_url}` is the authoritative channel — it matches the real `~/.hermes/config.yaml` schema; precedence is CLI > config.yaml > .env > defaults.

**Why profile-config over ACP per-session override (old Strategy A)**: `hermes acp --help` exposes no `--model`/`--provider`/`--base-url`; per-session provider override via ACP `session/new` is unconfirmed. The HERMES_HOME-profile path relies only on **confirmed** mechanisms (HERMES_HOME is real — used across 12+ source files; config.yaml schema verified). Old Strategy C (pure `OPENAI_*` env, no config) is insufficient — Hermes' own provider resolution reads config, not just the OpenAI-SDK env.

**Residual (→ gate T003)**: minimal-config sufficiency + `temperature`/`max_tokens` field placement must be confirmed against a capture proxy before the gate passes. Adapter currently writes `max_tokens` only when provided; `temperature` is unwired pending field confirmation.

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

## D1 — T000-LLM Spike Result (T003)

**Date**: 2026-06-04

### What the code shows

Analyzed the two core ACP integration files:

1. **`hermes-adapter.ts`** — The `session/new` JSON-RPC call (line 396-400) sends only three parameters: `{ cwd, model, mcpServers }`. The `model` field is a plain string (e.g. `"claude"`, `"gpt-4o"`). There are no fields for `provider`, `base_url`, `apiKey`, `temperature`, or `max_tokens` in the `AcpClientConfig` interface or anywhere in the wire protocol.

2. **`hermes-executor.ts`** — The model name is resolved from `input.persona.modelPreferences?.model ?? 'default'` (line 109) and passed as-is. The executor has no mechanism to inject provider routing, base_url overrides, or API keys into the ACP session. The fallback path (`LLMClient.complete`) handles its own provider routing independently.

3. **ACP protocol surface** — The full JSON-RPC surface observed is: `initialize` → `session/new` (with `cwd`, `model`, `mcpServers`) → `session/prompt` → `session/update` notifications. There is no `session/updateConfig`, `session/setProvider`, or similar per-session override method.

### Conclusion: **Strategy B** — Pool keyed by provider-config

The ACP protocol does **not** expose per-session provider/base_url/API key override. The model string passed to `session/new` is just a model name selector; the actual provider routing, base URL, and credentials are determined by the Hermes process's own profile/configuration at startup time.

**Strategy A (per-session override on a shared process) is not feasible** with the current ACP protocol. The warm-pool must be keyed by resolved effective config — one warm Hermes process per distinct `(provider, base_url, apiKey, model)` tuple — so that each process's startup configuration matches the tenant-assistant config it serves.

**Strategy C (ephemeral spawn) remains rejected** — NFR budget unacceptable.

### Rationale

- `session/new` params are `{ cwd, model, mcpServers }` only — no provider routing surface.
- Hermes docs confirm provider/base_url/key configuration at config/CLI/profile level, not at ACP session level.
- The `/model` interactive command (mentioned in docs) is a model-name switch within the already-configured provider, not a provider override.
- Pooling by config (Strategy B) is bounded — few distinct providers per deployment — and preserves warm-pool benefits without requiring ACP protocol changes.
