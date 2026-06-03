# Contract: Hermes Executor (010)

Engine = orchestrator + SoR + **safety interlock**. The real agent loop (incl. sub-agents) runs in a self-hosted **`hermes acp`** process (MIT, v0.15.1). **Integration shape verified empirically (T000a): ACP for the turn + an engine-hosted MCP server for tools.** The agent reaches the world ONLY through the engine MCP server.

```
turn-router ──scripted?──► 003 deterministic (Hermes may gen slot text under stage control)
     │ else (agentEnabled)
     ▼
 HermesExecutor.runAgentTurn ──ACP (JSON-RPC/ndjson/stdio)──► hermes acp  (managed process pool)
     ▲ session/update (stream)        │ tools/call (MCP)
     │ stopReason+usage               ▼
 engine MCP server  ─►  tool-gateway (allowlist + permission + idempotency + audit)
 guardrail (validators 004 + budget + maxExecutionMs)  ─►  persist / deliver
```

## Transport (T000a — verified)
- **ACP**: JSON-RPC 2.0 over stdio, **newline-delimited**. Engine is the ACP **client**; `hermes acp` is spawned/managed (warm-pool). Handshake: `initialize` → `session/new` → `session/prompt` → stream → response.
- **MCP**: engine runs an MCP server exposing the tool-gateway; passed per-session via `session/new.mcpServers` (`{type:'stdio'|'http', …}`). Native hermes toolsets disabled; the engine MCP is the agent's **only** toolset.
- The thin OpenAI path (`proxy`/OmniRoute) is the **fallback** completion only (FR-009), never the agentic path.

## `HermesExecutor.runAgentTurn(input)`
**Input** (engine-built, server-side):
```ts
{
  tenantId, personaId, conversationId,
  acpSessionId?,                // resume an existing ACP session (warm/hibernated) else session/new
  systemPrompt, userMessage, context: { rag, fewShot, history },
  mcpServer: { /* engine MCP endpoint for THIS turn — tenant+persona scoped */ },
  model,                        // from persona.modelPreferences (per-session switch)
  budget: { loopCap, tokenCap, costCeiling, maxExecutionMs },
  kind: 'reply' | 'dozhim',
  signal: AbortSignal,
}
```
Drives one ACP turn: ensure session (resume `acpSessionId` or `session/new` with `mcpServers:[engine]`) → `session/prompt` → consume `session/update` → resolve on `session/prompt` response.

**Status mapping (ACP `session/update` → 002 SSE):**
- `agent_message_chunk` → **answer** delta (the deliverable)
- `agent_thought_chunk` → `thinking`
- `tool_call` / `tool_call_update` (`toolCallId`, `title`, `rawInput`, status) → `tool_call` / `tool_result`
- `usage_update` + final response `usage` → metering (007) → `agent_runs`
- final `session/prompt` `{stopReason}` → `done` (+ `budget_exceeded`/`timeout` synthesized by the engine)

## Engine MCP server = the tool-gateway (the interlock)
Every `tools/call` from the agent lands here (this is where `executeTool` lives):
1. **Allowlist** — tool ∈ `persona.toolAllowlist` else `denied` (audited).
2. **Permission** — write-actions require per-tenant write-permission (allow-list entry `isWrite`).
3. **Idempotency** (write) — reserve→execute→finalize, see below.
4. **Execute** via engine-held creds (agent never holds them).
5. **Confirm/dry-run** for high-stakes (below).
6. **Audit** — `action_audit` row.
- **Tenant scope**: the per-session MCP server is bound to `(tenant, persona)`; all DB ops run inside `withTenantContext`. Native terminal/browser absent from the toolset.
- **Injection**: hermes auto-fences tool results as `<untrusted_tool_result>` (native) — defense-in-depth on top of validators.

### Idempotency & orphan handling (U1 + claude F2)
Write-action = **reserve → execute → finalize**, each in its **own committed txn** (external side-effect runs OUTSIDE any txn — no connection held, crash-durable):
1. **Reserve**: `INSERT action_audit(status='pending') ON CONFLICT (tenantId, idempotencyKey) DO NOTHING`. Conflict + terminal row ⇒ replay prior result (never re-execute); conflict + `pending` ⇒ `ConflictError` (in-flight). **Unique is composite `(tenantId, idempotencyKey)`** — per-tenant, no cross-tenant collision.
2. **Execute** the side-effect.
3. **Finalize**: `status = ok | failed`.
**Orphan**: a `pending` row past `TOOL_CALLBACK_TTL` (crash mid-loop) → swept `abandoned` + reconciled. No double-execute, no silent orphan.

### High-stakes confirm/dry-run (claude F4 + gemini F1) — enforced HERE, not in ACP
ACP **auto-approves** MCP tool calls (verified: no `session/request_permission`). So the engine MCP server is the sole gate: a tool with `requiresConfirmation` returns a **dry-run preview** result (`needs_confirmation` + preview) instead of executing; the engine surfaces `action_pending_approval` on the SSE; on operator/user approval the engine re-invokes with a confirm token → executes + finalizes. The agent cannot bypass — its only door is this server.

## Outbound gate (every final answer)
Assembled answer (`agent_message_chunk`s) → **validators (004)** → pass: persist + deliver; fail: block/regenerate. Never deliver un-validated output. Validators fail-closed on error.

## Fallback & timeout (FR-009 + gemini F2)
- Hard engine-side `maxExecutionMs` → abort the ACP turn (drop/kill process) → degrade to thin completion (`llm-client.complete` via `LLM_PROVIDER_URL`/OmniRoute — NOT `hermes proxy`); `agent_runs.fallbackUsed=true`.
- Hermes unavailable / `budget_exceeded` / `loopCap` → same fallback. Core chat survives a Hermes outage.
- **Honcho down/slow** → degraded/cold memory, turn proceeds, logged — never hard-fail.

## Budget boundary (claude F13)
Per-tenant budget exhausted → finish in-flight turn, refuse new agentic turns; per-turn cap hit → curtail + finalize best answer.

## Lifecycle (ACP-backed)
- **Warm-pool**: live `hermes acp` processes (Redis registry, keyed **`(tenant, persona)`** — one process per tenant+persona with an isolated memory store; that pair's conversations are ACP sessions *within* it, T000d).
- **Spawn**: new process or `session/new` on a pooled process; hydrate from SoR+Honcho (lazy).
- **Hibernate/Resume**: ACP `sessionCapabilities.{resume,fork,list}` → hibernate drops/keeps the session; resume re-attaches (no full rebuild).
- Durable state in Postgres+Honcho; process/Redis state ephemeral.
- **Resolved (T000d 🔴)**: cross-session memory leak confirmed → **process-per-(tenant, persona)** with an isolated memory store/HOME; sharing one process across tenants is unsafe. A (tenant, persona)'s conversations run as ACP **sessions within** its process — but in-process cross-conversation isolation requires hermes native memory **OFF + an isolated/empty per-process store** (engine owns per-conversation memory); T000d showed in-process sessions otherwise bleed, so until that's re-tested the conservative fallback is **process-per-conversation**.

## Proactive dožим (US3, via 009)
009 scan eligible → `lifecycle.spawn` → `runAgentTurn({kind:'dozhim'})` → 009 anti-spam + 004 validators → send/suppress (audited) → hibernate. Agent never sends directly.

## Security invariants
- **Tenant isolation**: Honcho namespace (per session/conversation) + Postgres RLS (composite-unique idempotency) + per-session engine-MCP scoped to `(tenant,persona)`. Zero cross-tenant memory/tool/data.
- **Secrets**: engine holds LLM/CRM creds at the MCP-server layer; agent gets none. LLM provider creds live in hermes' own config.
- **No direct agent outbound/action**: the engine MCP server is the only toolset; native terminal/browser off.
- **Metering**: every turn's usage (ACP `usage`) + tool calls → OpenMeter (007); per-tenant budget enforced.
