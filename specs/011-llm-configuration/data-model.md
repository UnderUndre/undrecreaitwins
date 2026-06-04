# Data Model: Per-Assistant LLM Provider Configuration (Runtime)

Engine SoR (Postgres / Drizzle). Two new entities + a pure resolution function. Column types follow the existing engine schema convention — **confirm exact Drizzle types against the current schema layout** before migration (flagged; not fabricated here).

## Entity: `LLMProviderConfig` (per-assistant override)

`1:0..1` with persona (008). Tenant-scoped (RLS).

| Field | Type (proposed) | Notes |
|---|---|---|
| `id` | uuid/cuid PK | engine id convention |
| `tenantId` | FK → tenant | RLS scope; NOT NULL |
| `personaId` | FK → persona(008) | UNIQUE (one override per assistant); NOT NULL |
| `providerType` | enum `'custom'` | MVP: Custom OpenAI-compatible only (DD-HXL-004 / Product DD-LLM-004) |
| `baseUrl` | text | absolute https; SSRF-validated before use (D5) |
| `modelId` | text | non-empty |
| `apiKeyCiphertext` | bytea/text | envelope-encrypted (D2); **never** plaintext at rest |
| `apiKeyRef` | text | KMS key id/version for decrypt; rotation handle |
| `temperature` | numeric | range 0..2; finite-guard |
| `maxTokens` | integer | > 0 |
| `enabled` | boolean | default true |
| `version` | integer | optimistic-lock (cf. funnel 002); increment on update |
| `createdAt` / `updatedAt` | timestamptz | audit |

**Validation** (FR-001/FR-004): `baseUrl` absolute + https + SSRF-safe; `modelId` non-empty; `temperature ∈ [0,2]`; `maxTokens > 0`; `providerType = 'custom'`. Key is **write-only** at the API boundary (never returned).

## Entity: `TenantLLMDefault` (tenant-level default)

Same provider fields, tenant-scoped, one per tenant.

| Field | Type (proposed) | Notes |
|---|---|---|
| `id` | uuid/cuid PK | |
| `tenantId` | FK → tenant | UNIQUE (one default per tenant); NOT NULL |
| `providerType` | enum `'custom'` | |
| `baseUrl` / `modelId` / `apiKeyCiphertext` / `apiKeyRef` / `temperature` / `maxTokens` / `enabled` | — | as above |
| `version` | integer | optimistic-lock |
| `createdAt` / `updatedAt` | timestamptz | |

## Resolution (pure function)

```
effectiveConfig(tenantId, personaId):
  override = LLMProviderConfig where personaId = personaId and enabled
  if override: return override
  tdefault = TenantLLMDefault where tenantId = tenantId and enabled
  if tdefault: return tdefault
  return PLATFORM_DEFAULT      # engine-wide built-in (existing single config)
```

- Clearing the assistant override → falls to tenant default.
- Clearing both → platform default (FR-011 / FR-008 path-scope governs both agentic + thin-completion).
- The resolved config is what the executor **injects** (contracts §injection) and what a durable-retry job re-resolves on each attempt (key decrypted fresh → honors rotation).

## Lifecycle / state

- Config rows: CRUD only (no state machine).
- **Retry job state** lives in BullMQ (queued → active → completed | retry-backoff → dead-letter), not in these tables (contracts §retry).
- **Secret lifecycle**: ciphertext at rest → decrypt **only** at injection / test-connection → plaintext never persisted, logged, or returned.

## Relationships

```
tenant 1───* LLMProviderConfig *───1 persona(008)     # override, UNIQUE(personaId)
tenant 1───0..1 TenantLLMDefault                       # default, UNIQUE(tenantId)
LLMProviderConfig.apiKeyRef ──> KMS key (007)          # envelope decrypt
turn ──uses──> effectiveConfig(tenant, persona)        # injected into Hermes ACP (010)
```

## Notes

- No change to persona(008) columns required — relation is by FK from the new table (don't widen persona).
- Indexes: `UNIQUE(personaId)` on override, `UNIQUE(tenantId)` on default, `INDEX(tenantId)` for RLS scans.
- Migration generated as a reviewable `.sql` (Standing Order 5 — no direct apply).
