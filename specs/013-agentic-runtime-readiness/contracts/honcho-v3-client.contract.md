# Contract: Honcho v3 Client (`honcho-client.ts` rewrite)

**Scope**: `packages/core/src/services/hermes/honcho-client.ts`. Migrate from legacy `apps/users` to Honcho **v3** (`workspaces/peers`, `/v3` prefix) while keeping the **engine-facing method surface unchanged**. Targets honcho **v3.0.9**.

## Configuration

| Env | Required | Meaning |
|---|---|---|
| `HONCHO_URL` | yes | Base URL (`http://honcho:8080` in-compose; `http://localhost:8083` host). Client appends `/v3`. |
| `HONCHO_API_KEY` | no | Optional bearer; omitted when blank (research §b — verify v3.0.9 default). |

Missing `HONCHO_URL` → throws `AppError('HONCHO_URL is required', 500, 'configuration_error')` (unchanged).

## Method surface (signatures preserved — callers untouched)

| Method | v3 behavior | Degradation |
|---|---|---|
| `getInsights(tenantId, personaId, externalUserId?)` | get-or-create workspace+peer → fetch **peer representation / peer-context** → return `{id,content,metadata}[]` | error → `[]` + classified signal |
| `addMessage(tenantId, personaId, sessionId, role, content, externalUserId?)` | ensure workspace/peer/session → `POST /v3/workspaces/{tenantId}/sessions/{sessionId}/messages` `{content, role}` | error → no-op + classified signal |
| `ensureSession(tenantId, personaId, sessionId, externalUserId?)` | get-or-create workspace → peer → session → `set-session-peers` | error → no-op + classified signal |

> If the current file exposes more methods than shown above, each follows the same rule: **same signature/return shape**, v3 endpoints inside, classified degradation.

## Identity construction

- workspace_id = `tenantId` (get-or-create per workspace)
- peer_id = `externalUserId ? p-{personaId}-u-{externalUserId} : p-{personaId}`
- session_id = caller-supplied `sessionId`
- All path segments `encodeURIComponent`-escaped (preserved from current client).

## Identity resolution, caching & idempotency (FR-013 — codex F7, gemini F4/F5)

Naive get-or-create of workspace+peer+session before **every** memory op is a 3× N+1 against Honcho on the per-turn path. Required:

- **In-process cache** of resolved IDs keyed by `tenantId` (workspace), `(tenantId,peerId)` (peer), `(tenantId,sessionId)` (session). On cache hit, skip the get-or-create round-trips. Bounded (LRU/Map with a sane cap); cache only *successful* resolutions.
- **Idempotent creation**: a create that returns `409`/already-exists MUST fall back to GET the existing resource (two concurrent first-turns for a new tenant must not leave one unable to write). Treat 409 as success, not error.
- Cache is **best-effort**: a stale/evicted entry just re-resolves; it never causes a turn to fail.

## Error classification (FR-007 — the core behavioral change)

| Condition | Class | Action |
|---|---|---|
| connect refused / timeout / 5xx | `transient` | `logger.warn({err,...},'honcho degraded (transient)')` + `honcho_degraded` metric; return empty/no-op |
| 404 on `/v3` path, 4xx schema mismatch, version mismatch | `permanent` | `logger.error({err,...},'honcho API mismatch')` + raise **`/v1/health.checks.honcho_memory`** + `honcho_degraded`; return empty/no-op |
| success | — | return data |

> `409`/already-exists is **NOT** an error class — it is handled as success (GET existing) per Identity resolution above.

**Invariant**: a honcho failure NEVER throws into the turn (FR-006). The only loud-but-non-fatal path is the permanent-mismatch readiness flag.

## Acceptance

- **AC1**: with honcho v3.0.9 up, `addMessage` then `getInsights` for the same `(tenant,persona)` round-trips (write visible in read). (SC-003)
- **AC2**: tenant A cannot read tenant B's memory — distinct workspaces. (SC-004, FR-008)
- **AC3**: honcho stopped → turn still completes; `transient` signal emitted. (SC-005, FR-006)
- **AC4 (RED-first)**: pointed at a legacy/no-`/v3` API → `permanent` class, `/v1/health.checks.honcho_memory` raised (loud), turn still completes fail-open. Written to fail before T010. (FR-007, codex F5)
- **AC5 (contract test)**: exact v3 field names + `/v3` prefix verified against the running image (research §a/§c).
- **AC6**: a second memory op for the same `(tenant,persona,session)` issues **no** redundant get-or-create calls (cache hit) — asserts no per-turn N+1. (FR-013, gemini F4)
- **AC7**: a create returning `409` → client GETs the existing resource and proceeds (no write lost). (FR-013, gemini F5)
- **AC8 (concurrency)**: two simultaneous first turns for a new tenant both succeed (one creates, one 409→GET) — no lost write, no crash. (codex F7)
