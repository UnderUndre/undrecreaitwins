# Data Model: Agentic Loop Runtime Readiness (013)

**No new persistent engine DB entities and no migration.** This feature provisions runtime + rewrites an external-API client. The "entities" below are **runtime/conceptual** — they describe state at boot and the Honcho v3 namespace mapping, not Postgres tables.

## Runtime entities

### Engine Runtime Environment
The process context running `twin-engine-api` (and workers) — a **container** (compose) or a **host** process (dev).
- **Owns**: `PATH` (must resolve `hermes`), runtime env (`HERMES_ACP_CMD`, `HONCHO_URL`, optional `HONCHO_API_KEY`, `AGENT_MAX_EXECUTION_MS`).
- **Container variant**: built from `packages/api/Dockerfile` (Node 20 + Python 3.12 + `hermes-agent[acp]==0.15.1`).
- **Host variant**: Hermes is a documented host prerequisite (matching today's dev venv).
- **Invariant**: in both variants, `HERMES_ACP_CMD[0]` MUST resolve to a working `hermes` with the `acp` subcommand.

### Hermes Runtime Dependency
The external Hermes CLI the engine spawns per tenant.
- **Identity**: `hermes-agent` **0.15.1**, `[acp]` extra; exposes `hermes acp` (JSON-RPC/ndjson over stdio) + `hermes acp --check`.
- **Compatibility key**: ACP `protocolVersion 1` (what `hermes-adapter.ts` speaks).
- **Lifecycle**: process-per-tenant with isolated `HERMES_HOME` (spec 010 T000d) — **owned by 010, not changed here**.

### Preflight Result *(transient, at boot)*
Outcome of the startup Hermes check.
- **Fields**: `ok: boolean`, `resolvedCommand: string`, `acpProtocolVersion?: number`, `error?: { code: 'hermes_missing' | 'acp_incompatible' | 'check_failed'; message }`.
- **Effect**: `ok=false` → engine throws typed `configuration_error` and refuses ready/healthy (FR-003). Never deferred to a user turn.

### Memory Health Signal *(transient, per-call + aggregate)*
Replaces the current silent `catch → []`.
- **Classification**: `transient` (connect refused / 5xx / timeout → warn + degrade) vs `permanent` (404 on `/v3` path, schema/version mismatch → error + readiness flag) (FR-007).
- **Surface**: structured `pino` log + a `honcho_degraded` metric/health field. Degradation never fails the turn (FR-006).

## Honcho v3 namespace mapping (FR-005, FR-008)

| Engine identity | v3 primitive | Notes |
|---|---|---|
| `tenantId` | **workspace** `{tenantId}` | get-or-create; **isolation unit** — cross-tenant reads impossible across workspaces |
| `personaId` (+ optional `externalUserId`) | **peer** | `p-{personaId}` or `p-{personaId}-u-{externalUserId}`, scoped to the workspace |
| conversation `sessionId` | **session** | get-or-create; `set-session-peers` to attach the peer |
| message (`role`, `content`) | `POST /v3/workspaces/{ws}/sessions/{id}/messages` | unchanged write semantics |
| "insights" / working memory | **peer representation / get-peer-context** | client preserves `{id,content,metadata}[]` return shape |

**Client boundary invariant**: the v3 migration is fully contained in `honcho-client.ts`. Callers (`hermes-executor` context build) see the **same method signatures and return shapes** — no ripple.

## State transitions

```
boot → preflight(hermes) ──ok?──▶ ready (accept turns)
                          └─fail─▶ unhealthy (typed configuration_error; no turns)

turn → honcho call ──success──▶ memory written/read
                    ├─transient─▶ degrade (warn + metric) → turn continues, no memory
                    └─permanent─▶ degrade + readiness flag (loud) → turn continues, no memory
```
