# Quickstart: Per-Assistant LLM Provider Configuration (Runtime)

Verification flow for the engine half. Assumes 010-hermes-executor running (pooled ACP) + 009 BullMQ + Postgres.

## 0. Gate T000-LLM (run FIRST)

Spike: open an ACP `session/new` against a pooled `hermes-agent` and attempt a per-session model/provider/base_url override.
- **Takes effect without restart** → Strategy **A** (per-session override). Proceed.
- **No effect** → Strategy **B** (pool keyed by provider-config). Proceed with config-keyed pool.

## 1. Configure a provider (BFF-facing API)

```
PUT /v1/assistants/{assistantId}/llm-provider
{ "providerType":"custom", "baseUrl":"https://<openai-compatible>/v1",
  "modelId":"<model>", "temperature":0.7, "maxTokens":2048, "apiKey":"<key>" }
```
Expect `200` with masked key (`hasKey:true`, `keyLast4`). Re-`GET` → key NOT returned.

## 2. Effective resolution

- No override → `GET …/llm-provider` shows `source:'tenant'` (if a `TenantLLMDefault` is set) else `'platform'`.
- Set override → `source:'assistant'`. `DELETE` override → back to tenant/platform.

## 3. Provider actually applied (parity)

Run an agentic turn for the assistant. Verify via trace/metering it hit the configured `baseUrl`/`modelId` (not the platform default). Validators (004) still gate output.

## 4. Durable-retry (no message loss, no model-swap)

- Point the provider at an unreachable/invalid endpoint → send a prod-path turn.
- Expect: turn **enqueued** (BullMQ `llm-provider-retry`), retried on the **same** provider with backoff; **no** thin-completion swap.
- Restore the provider → queued turn completes + delivers.
- Leave it down past the window → **dead-letter + operator alert** (not silent drop).

## 5. Secret + SSRF safety

- Grep logs/traces for the key → **zero** occurrences (plaintext only in-memory at injection).
- `PUT` a `baseUrl` of `http://169.254.169.254/...` or `http://127.0.0.1` → `SSRF_BLOCKED`.
- Concurrency: two tenants with different providers → no cross-tenant key/provider use in the pool (D3).

## 6. Metering

- A BYOK turn emits OpenMeter usage with `byok:true`; loop/token caps + tenant budget still enforced.

## Done when

SC-001..SC-006 hold: provider applied with 0 drift; 0 cross-tenant key use; 0 key in logs; 0 lost messages; 100% SSRF blocked; warm-pool budget within tolerance.
