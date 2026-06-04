# Research: Hermes Executor (010)

## (a) `hermes-agent` license — ✅ RESOLVED (GREEN)
**Finding**: `NousResearch/hermes-agent` is **MIT** (v0.15.1 verified locally — §i). Self-hosted multi-tenant use AND SaaS resale are permitted with no fair-code/embed restriction — unlike n8n (Sustainable Use) or Activepieces (EE-for-embed). **No license blocker.** (Sources: github.com/NousResearch/hermes-agent/LICENSE.)
**Decision**: self-host (C3). Engine owns data/keys.

## (b) Integration shape — ACP (turn) + engine-MCP (tools) ✅ VERIFIED (T000a smoke)
**Decision**: engine (TS/Fastify) drives a self-hosted **`hermes-agent` in ACP mode** (`hermes acp`, JSON-RPC 2.0 over stdio, **newline-delimited**) as an ACP **client** to a managed process pool. The agent reaches the world ONLY through tools served by an **engine-hosted MCP server** (the tool-gateway exposed over MCP); native terminal/browser/sub-agents **off unless allow-listed**. Per-session `mcpServers` are passed in `session/new`, so the agent's entire toolset = the engine MCP.
**Rationale**: ACP runs the real agent loop (incl. sub-agents) server-side; MCP keeps every side-effect behind the engine tool-gateway (allow-list + permission + idempotency + audit). Standard protocols, no bespoke callback bridge; agent never holds tenant secrets or hits external systems directly.
**Note**: the thin OpenAI-compatible path (`hermes proxy` / OmniRoute) is the **fallback completion only** (FR-009), not the agentic path.

## (c) Memory — Honcho working + engine SoR
**Decision**: Honcho namespace per `(tenantId, personaId[, externalUserId])`; holds working/user-model memory. Engine Postgres remains SoR (messages/persona/annotations/outcomes/RAG). Honcho MUST be reconstructible from SoR — nothing of record lives only in Honcho (portability). Letta dropped.
**Open**: confirm Honcho enforces per-tenant namespace isolation (T000b).

## (d) Lifecycle — spawn-on-demand + hibernate + warm-pool
**Decision**: agents spawn on a turn/heartbeat, hydrate from SoR+Honcho, hibernate/evict after idle TTL. **Backends**: Docker baseline; **Modal/Daytona** offer serverless persistence (good hibernate fit). Warm-pool keeps hot/premium twins warm. Proactivity is driven by the **engine 009 BullMQ scheduler** (heartbeat) — not Hermes' native always-on cron. Durable state never only in agent RAM.

## (e) Status streaming — ACP `session/update` ✅ VERIFIED
**Decision**: the agent streams ACP `session/update` notifications; the engine maps them to its SSE (002): `agent_message_chunk` → answer delta; `agent_thought_chunk` → `thinking`; `tool_call`/`tool_call_update` (carry `toolCallId`, `title`, `rawInput`, status, content) → `tool_call`/`tool_result`; `usage_update` + final `session/prompt` `usage` → metering (007). Turn ends on the `session/prompt` response with `stopReason` (`end_turn`/…). Channels get the final answer.

## (f) Cost control (always-agent ⇒ critical)
**Decision**: per-turn **hard loop cap** (max agent iterations) + token cap, and a **per-tenant budget** metered to OpenMeter (007). Over budget → curtail loop + fall back to a single completion; never unbounded spend. Provider routing via OmniRoute (also where metering hooks).

## (g) Routing
**Decision**: scripted (003 funnel active) → deterministic stage/slot path; **every other turn → Hermes (always-agent)**. Thin completion (`llm-client.ts`) survives only as the outage fallback.

## (h) Action / write model
**Decision**: write-actions (CRM/calendar/booking/external mutations) execute **only via the engine tool-gateway** under: per-persona permission allow-list, **idempotency key** (UNIQUE), audit log, validators gate; **high-stakes actions** require a confirm/dry-run step — **enforced at the engine MCP server** (the `tools/call` handler returns a dry-run / needs-confirmation result or denies), NOT via ACP's permission prompt: the smoke showed ACP **auto-approves** MCP tool calls (no `session/request_permission` fired), so the gateway is the sole authority. v1 includes write-actions (C1).

## (i) Integration contract — Gate T000a ✅ VERIFIED EMPIRICALLY (local smoke, 2026-06-03)
**Installed/verified**: `hermes-agent` **v0.15.1** (CLI on PATH). `hermes acp --check` → OK. Two smokes passed on this machine. *(Supersedes the earlier v0.7.0 OpenAI-REST assumption — the agentic loop is NOT an OpenAI HTTP endpoint; `proxy` is a thin LLM forwarder only.)*
- **Turn transport**: `hermes acp` — JSON-RPC 2.0 over stdio, **newline-delimited (ndjson)** framing (NOT Content-Length). Sequence: `initialize` (protocolVersion 1, clientCapabilities `{fs,terminal}`) → `session/new` (`cwd`, `mcpServers[]`) → `session/prompt` (`prompt: ContentBlock[]`) → streamed `session/update` → response `{stopReason, usage}`.
- **Lifecycle hooks**: `agentCapabilities.sessionCapabilities = {fork, list, resume}` + `loadSession` → **hibernate = drop/keep session; resume = re-attach** (maps to warm-pool). Per-session model switch available.
- **Tools (MCP)**: external MCP server passed in `session/new.mcpServers`; **both `stdio` and `http` transports VERIFIED** (out-of-band marker proves `tools/call` routing). Engine uses **`http`** (in-process, shares DB). **Entry-shape gotcha (hermes Pydantic, verified)**: `name` is **REQUIRED**; `headers`/`env` must be a **LIST `[{name,value}]`**, not an object; the http server may reply plain `application/json` (no SSE needed); no `Mcp-Session-Id` required. Tool namespaced `mcp_<server>_<tool>`. **Tool results auto-fenced by hermes** in an `<untrusted_tool_result>` envelope — built-in prompt-injection defense (safety plus).
- **Permission**: MCP tool calls **auto-approve** in ACP (no `session/request_permission` observed) → confirm/dry-run/deny MUST be enforced by the engine MCP server (§h).
- **Secrets**: LLM creds live in hermes' own config (custom endpoint); engine does not pass LLM keys. Per-tenant model/provider injection = pool design point.
- **Provider note**: local default custom endpoint (glm-5.1) showed a `finish_reason=length` truncation quirk — provider-side; mitigated by `maxExecutionMs` + a production-grade model.
**Gate T000d — RESULT 🔴 FAIL (smoke 2026-06-03)**: in ONE `hermes acp` process, session A stored a secret via the built-in `memory` tool; session B (different ACP session, same process) **retrieved it** ("Banana7"). hermes' native memory is **process/user-global, not session-scoped** → cross-session = cross-tenant leak. **Memory-OFF re-test (2026-06-03) → STILL LEAKS**: with the memory *tool* disabled, run-1's secret (persisted, durable) was **auto-injected into both sessions at load** (no tool call) — disabling the tool blocks new writes but NOT the read/injection of the existing global store. **Confirmed decision: process-per-tenant with an isolated memory store/HOME per tenant.** Within one tenant's process, multiple conversation sessions are fine (shared memory = same tenant, not a leak) → pooling unit = **process-per-tenant, not per-conversation**.
