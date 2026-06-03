# Data Model: Hermes Executor (010)

All new tables tenant-scoped via Postgres **RLS** (`app.current_tenant`, `withTenantContext`). Honcho working-memory is **external** (not an engine table) and reconstructible from this SoR.

## 1. `personas` — EXTEND

| Column | Type | Notes |
|--------|------|-------|
| `agentEnabled` | boolean | default `false`. If `true`, non-scripted turns route to Hermes (else thin completion). |
| `toolAllowlist` | jsonb | array of tool entries `{ id, isWrite?, requiresConfirmation? }` (e.g. `[{"id":"rag.search"},{"id":"crm.read"},{"id":"crm.write","isWrite":true,"requiresConfirmation":true}]`). Terminal/arbitrary-browser absent ⇒ disabled. `requiresConfirmation` drives high-stakes confirm/dry-run (claude F4 / A1). |
| `agentConfig` | jsonb | `{ loopCap, tokenCap, budgetTier, honchoNamespace?, highStakesActions: string[] }` (cost guard + confirm/dry-run list). |

## 2. `agent_runs` — NEW (engine record of each agentic turn)

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `tenantId` | text | RLS key (tenant PKs migrated uuid→text) |
| `personaId` | uuid FK → personas.id | |
| `conversationId` | uuid FK → conversations.id | |
| `kind` | text | `reply` \| `dozhim` (proactive, 009) |
| `status` | text | `running` \| `done` \| `failed` \| `aborted` \| `budget_exceeded` \| `fellback` |
| `llmCalls` / `toolCalls` | integer | for metering/observability |
| `tokensIn` / `tokensOut` / `costEstimate` | integer / numeric | per-turn cost (→ OpenMeter, 007) |
| `fallbackUsed` | boolean | true if Hermes-outage → completion path |
| `honchoSessionRef` | text | working-memory handle (reconstructible) |
| `startedAt` / `endedAt` | timestamptz | latency |

Index: `(tenantId, conversationId, startedAt)`; `(tenantId, status)`.

## 3. `action_audit` — NEW (every tool/action the agent ran)

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `tenantId` | text | RLS key (tenant PKs migrated uuid→text) |
| `personaId` | uuid | |
| `agentRunId` | uuid FK → agent_runs.id | |
| `action` | text | tool/action id (e.g. `crm.write`) |
| `argsRedacted` | jsonb | secrets/PII redacted (NFR-2) |
| `isWrite` | boolean | write-action vs read |
| `idempotencyKey` | text | **UNIQUE** for write-actions (FR-012) — no double-execute |
| `status` | text | **reserve→execute→finalize** (FR-012): `pending` → `ok` \| `failed`; plus `denied` \| `dry_run` \| **`abandoned`** (orphaned callback swept after `TOOL_CALLBACK_TTL` — claude F2) |
| `createdAt` | timestamptz | |

Constraint: `UNIQUE(idempotencyKey)` (write-actions). **Reserve** via `INSERT … ON CONFLICT (idempotencyKey) DO NOTHING` (status `pending`) **before** the external side-effect; finalize after. Conflict ⇒ replay prior result (no re-execute). A `pending` row past `TOOL_CALLBACK_TTL` → swept `abandoned` + reconcile (contract §Idempotency & orphan handling). Index: `(tenantId, agentRunId)`, `(status, createdAt)` (sweep).

## Lifecycle / warm-pool state
Not a table — kept in **Redis** (active-agent registry, warm-pool, idle TTL). Durable record stays in Postgres+Honcho; RAM/Redis state is ephemeral (FR-005).

## Honcho (external working memory)
Namespace per `(tenantId, personaId, conversationId)` — per-conversation session isolation (claude F7); cross-session user-model may roll up per `(tenantId, personaId, externalUserId)`. Holds derived user-model + agent scratchpad. **Reconstructible from SoR** (messages/annotations/outcomes). **Reconstruction mechanism (U2/claude F10)**: on spawn, if the namespace is empty/stale, seed working memory from last-N messages + annotations (SoR); triggered automatically on a Honcho health-miss or manually via admin. **Honcho down/slow → degrade to cold memory** (turn proceeds, no enrichment), never hard-fail. Engine never treats Honcho as the only copy of anything of record. (T004 implements + tests the SoR→Honcho round-trip.)

## Migration
One reviewed `.sql` (Standing Order 5): persona ALTER (3 cols) + `agent_runs` + `action_audit` (+ UNIQUE idempotency) + RLS policies + indexes. Not auto-applied.
