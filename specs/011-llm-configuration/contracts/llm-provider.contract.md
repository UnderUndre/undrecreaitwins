# Contract: LLM Provider Configuration (Engine Runtime)

Internal engine surface consumed by the Product BFF (`ai-twins/011`) + internal injection/retry contracts. Auth: engine Bearer + `X-Tenant-ID` → RLS. Tenant/role derived server-side (007), never from client. **API key is write-only** — never returned, never logged.

## A. Config API (BFF-facing)

### Tenant default
- `GET /v1/tenants/{tenantId}/llm-provider`
  → `200 { providerType, baseUrl, modelId, temperature, maxTokens, enabled, hasKey, keyLast4 }` *(no plaintext key)*; `404` if unset.
- `PUT /v1/tenants/{tenantId}/llm-provider`
  body `{ providerType:'custom', baseUrl, modelId, temperature, maxTokens, enabled, apiKey? }` (apiKey write-only; omit = keep existing)
  → `200` upserted (masked); `400 VALIDATION`; `403`; `409 CONFLICT` (optimistic-lock).

### Assistant override
- `GET /v1/assistants/{assistantId}/llm-provider`
  → `200 { effective:{...masked, source:'assistant'|'tenant'|'platform'}, override?:{...masked} }`.
- `PUT /v1/assistants/{assistantId}/llm-provider`
  body as above → upsert override (masked).
- `DELETE /v1/assistants/{assistantId}/llm-provider`
  → `204` clear override (falls to tenant default).

### Test connection
- `POST /v1/assistants/{assistantId}/llm-provider/test-connection`
  body `{ baseUrl, modelId, apiKey? }` (uses stored key if omitted)
  → `200 { ok:true }` | `200 { ok:false, reason:'AUTH'|'TIMEOUT'|'MODEL_NOT_FOUND'|'UNREACHABLE'|'SSRF_BLOCKED' }`
  — **never** returns the key or the raw upstream body; rate-limited per-user/per-tenant.

**Error taxonomy** (typed; sanitized): `VALIDATION`, `SSRF_BLOCKED`, `UPSTREAM_AUTH`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `RATE_LIMIT`, `CONFLICT`, `FORBIDDEN`. No raw upstream passthrough.

## B. Injection contract (internal — executor ↔ provider-config)

```
onAgenticTurn(tenant, persona, turn):
  cfg = resolveEffectiveConfig(tenant, persona)     # data-model §resolution
  assertCoherent(cfg, tenant, persona)              # D3 — no stale/foreign config
  key = crypto.decrypt(cfg.apiKeyCiphertext, cfg.apiKeyRef)   # decrypt at injection only
  ssrf.assertAllowed(cfg.baseUrl)                   # D5 — DNS-pin
  inject(session, { provider:'custom', baseUrl:cfg.baseUrl, model:cfg.modelId,
                    apiKey:key, temperature:cfg.temperature, maxTokens:cfg.maxTokens })
  # strategy A: per-session ACP override (gate T000-LLM PASS)
  # strategy B: route to config-keyed warm process (gate FAIL)
  meter.emit({ ...usage, byok:true })               # D6
```

### SSRF DNS Pinning

The SSRF guard MUST perform DNS resolution before checking the IP, not just URL string matching. Implementation:

1. Resolve hostname → IP addresses (both A and AAAA records).
2. Check ALL resolved IPs against the deny list (including IPv6: `::1/128`, `fe80::/10`, `fc00::/7`, `ff00::/8`).
3. If any resolved IP is in the deny list → reject.
4. Use a custom `dns.lookup` override on the HTTP agent to pin the connection to the approved IP, preventing DNS rebinding at request time.
5. Disable HTTP redirects on the egress client. If redirects are needed in future, re-validate the redirect target through the same SSRF check.

IPv6 deny ranges:
- `::1/128` (loopback)
- `fe80::/10` (link-local)
- `fc00::/7` (unique-local / ULA)
- `ff00::/8` (multicast)

- Applies to **both** the agentic (Hermes ACP) path and the thin-completion path (`llm-client.ts`) for the same assistant (FR-009) — no provider drift on fallback.
- Guardrails unchanged: validators (004) gate output regardless of provider (DD-HXL-005).

## C. Durable-retry contract (internal — 009 BullMQ)

```
on provider failure (UPSTREAM_* on prod reply-path):
  enqueue('llm-provider-retry', { turnId, tenantId, personaId, attempt:1 })
  worker: re-resolve cfg (fresh decrypt → honors key rotation); retry SAME provider
          exponential backoff (5s → ~2min cap); maxAttempts/maxWindow
  on success: deliver via normal channel
  on window exhausted: → dead-letter queue + operator alert  (no silent drop, no model-swap)
```

- **Refines 010 FR-009**: thin-completion model-swap is NOT used for a BYOK provider failure (DD-HXL-003). Executor-process outages (provider healthy) still follow 010 FR-009.
- Sandbox/interactive (Product 010): synchronous typed error + manual retry — **not** enqueued.

## D. Non-functional contract

- Key never in logs/traces/error bodies (NFR secrets); secrets redacted in audit (FR-011).
- Cross-tenant key isolation in the pool (NFR isolation; D3).
- p95 warm-pool budget preserved (010) — injection strategy must not collapse reuse.
- Migration delivered as reviewable `.sql` (Standing Order 5).
