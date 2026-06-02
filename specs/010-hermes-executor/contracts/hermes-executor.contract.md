# Contract: Hermes Executor (010)

Engine = orchestrator + SoR + **safety interlock**. `hermes-agent` (self-host, MIT) = the agent loop. **The agent reaches the world ONLY via the engine tool-gateway.** A thin **adapter** isolates the `hermes-agent` HTTP contract (claude F3) so a pre-1.0 (v0.7.0) API change can't silently break the engine.

```
turn-router ──scripted?──► 003 deterministic (Hermes may generate slot text under stage control — F4)
     │ else (agentEnabled)
     ▼
 HermesExecutor.runAgentTurn ──adapter/HTTP──► self-host hermes-agent (loop)
     ▲  tool/action callbacks  │ status events (incl. action_pending_approval)
     │                         ▼
 tool-gateway (allowlist+permission+idempotency+audit)   guardrail (validators 004 + budget + timeout) → persist/deliver
```

## `HermesExecutor.runAgentTurn(input)`

**Input** (engine-built, server-side):
```ts
{
  tenantId, personaId, conversationId,
  sessionId,                    // = (tenantId, personaId, conversationId) — per-conversation isolation (F7)
  systemPrompt, context: { rag, fewShot, history },
  toolManifest: ToolSpec[],     // ONLY persona.toolAllowlist; each carries { isWrite, requiresConfirmation }
  honchoNamespace,              // includes conversationId (F7) — concurrent turns don't collide
  budget: { loopCap, tokenCap, costCeiling, maxExecutionMs },  // F008 + hard timeout (gemini F2)
  kind: 'reply' | 'dozhim',
  signal: AbortSignal,
}
```
Returns an async stream of **StatusEvent** + a final result. Adapter layer pins the hermes-agent version contract (T000a).

**StatusEvent** (SSE, extends 002): `thinking` · `tool_call` · `tool_result` · `answer`(delta) · **`action_pending_approval`** (high-stakes pause, F4/gemini F1) · `done` · `error` · **`timeout`** · `budget_exceeded`.

## Session isolation (claude F7)
A Hermes session is **per (tenant, persona, conversation)**. Two users chatting with the same persona get separate sessions + separate Honcho sub-namespaces (`honchoNamespace` includes `conversationId`). No cross-conversation working-memory mutation.

## Tool-gateway (engine-mediated)
Every tool/action the agent calls routes here:
1. **Allowlist** — tool id ∈ `persona.toolAllowlist` else `denied` (audited).
2. **Permission** — write-actions require write permission; tenant-scoped.
3. **Idempotency protocol** (write, FR-012) — see below.
4. **Execute** — via engine-held creds (agent never holds them).
5. **High-stakes** — `requiresConfirmation` → confirm/dry-run flow (below).
6. **Audit** — `action_audit` row.

### Idempotency & orphan handling (U1 + claude F2)
Write-action protocol = **reserve → execute → finalize**:
1. **Reserve**: `INSERT action_audit(idempotencyKey, status='pending') ON CONFLICT (idempotencyKey) DO NOTHING`. Conflict ⇒ replay: return the prior row's result, **never re-execute**.
2. **Execute** the external side-effect (downstream idempotency key passed where the provider supports it).
3. **Finalize**: `status = 'ok' | 'failed'` + result.
**Orphan handling**: a `pending` row whose tool-callback isn't consumed within `TOOL_CALLBACK_TTL` (Hermes crashed mid-loop, F2) → swept to `status='abandoned'`; provisional/un-finalized side-effects are reconciled (compensating action where defined, else flagged for review). No double-execute, no silent orphan.

### High-stakes confirm/dry-run (claude F4 + gemini F1)
- **Classification**: an action is high-stakes if its `toolAllowlist` entry has `requiresConfirmation: true` (operator-config per persona/tool — no hidden criterion; A1).
- **Dry-run**: gateway runs the action in dry-run (no commit) and returns a preview.
- **Confirm flow**: gateway emits `action_pending_approval` (preview + action id) → **pauses** the turn → approver (operator in sandbox; configurable for prod) approves/rejects → gateway **resumes** the agent with the result (or aborts). Asynchronous: the agent session is suspended (lifecycle), not blocking a worker.

## Outbound gate (every final answer)
Hermes answer → **validators (004)** → pass: persist + deliver; fail: block/regenerate. Never deliver un-validated agent output.

## Fallback & timeout (FR-009 + gemini F2)
- **Hard engine-side timeout** `maxExecutionMs`: exceed → emit `timeout`, force-abort the Hermes call, degrade to `llm-client.complete()` (thin completion); `agent_runs.fallbackUsed=true`.
- Hermes unavailable / `budget_exceeded` → same fallback. Core chat survives a Hermes outage.
- **Honcho down/slow** (claude F1): turn proceeds with degraded/cold memory (no working-memory enrichment), logged — never hard-fail on memory-store outage.

## Budget boundary (claude F13)
Per-tenant budget exhausted → **complete the in-flight turn, refuse new agentic turns** (route to thin completion or a "limit reached" message); per-turn `loopCap`/`tokenCap` hit → **curtail the loop and finalize** the best answer (not a hard mid-sentence kill). Never unbounded spend.

## Proactive dožим (US3, via 009)
009 scan eligible → `agent-lifecycle.spawn` → `runAgentTurn({kind:'dozhim'})` → **009 anti-spam + 004 validators** gate → send/suppress (audited) → hibernate. Agent never sends directly.

## Tools in scope v1 (claude F11)
v1 ships the **tool-gateway + a starter tool set**: `rag.search` (engine-native, 005), `crm.read`/`calendar.read` + one write exemplar (`crm.write` or `calendar.book`) via **adapter stubs**. Broad concrete external integrations (full CRM/calendar matrix) are a **future spec** — the gateway + allowlist make them additive.

## Lifecycle API
`spawn(sessionId)` → hydrate from SoR+Honcho (**lazy/background hydration** to cut TTFT — gemini F5) · `suspend` (for confirm pause) · `hibernate(idleTTL)` · `evict` · warm-pool (default size configured in Phase 2, F6). State in Redis; durable state in Postgres+Honcho.

## Security invariants
- **Tenant isolation**: Honcho namespace (incl. conversationId) + Postgres RLS + tool-gateway tenant-scope. Zero cross-tenant memory/tool/data.
- **Secrets**: engine holds LLM/CRM keys; agent gets none — gateway executes (NFR-2).
- **No direct agent outbound/action**: everything passes the gate.
- **Metering**: every LLM/tool call → OpenMeter (007); per-tenant budget enforced (boundary above).
