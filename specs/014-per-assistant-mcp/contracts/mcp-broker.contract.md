# Contract: MCP Broker (runtime)

**Scope**: `packages/core/src/services/hermes/{mcp-client.ts, mcp-broker.ts}` + extensions to `mcp-server.ts` / `tool-gateway.ts` / `hermes-executor.ts`. Brokers a persona's external MCP tools through the engine gateway. **The agent never receives a direct external `mcpServers` entry.** (FR-004)

## mcp-client.ts (minimal MCP client)
- `connect(entry)` → `initialize` over HTTP, SSRF dispatcher (011) **pinned to the IP resolved at validation — NOT re-resolving the hostname** (DNS-rebinding, opencode F1), `timeout_ms` bound, decrypted auth headers (011 KMS).
- **Max response size ~1 MB** on every call — oversized → abort stream + mark entry degraded (OOM defense, gemini F4 / opencode F11).
- `listTools(entry)` → `tools/list` (caller caches).
- `callTool(entry, name, args)` → `tools/call`; returns content, preserving the `<untrusted_tool_result>` fence (FR-009).
- Errors are typed; never throw raw secrets into logs (redact).

## mcp-broker.ts
At session build, for persona P (tenant T):
1. Load enabled bindings for P (RLS-scoped). 
2. For each entry: `listTools` via **TTL cache** (key = entry id; refresh on expiry/rescan) — no per-turn N+1 (FR-013). Multi-entry cache-miss discovery runs **concurrently** (`Promise.allSettled`, bounded), not sequentially (gemini F3 / opencode F6); invalidate an entry's cache on a call-time `tool not found`/`invalid params` (drift, opencode F8).
3. Apply server `tools_include/exclude` + binding `tool_overrides`.
4. For each surviving tool, synthesize a `ToolDefinition`:
   - `name = mcp_<entryName>_<tool>` (namespaced, FR-010); **reject or deterministically truncate** if the synthesized name would exceed the LLM limit (≤64 chars, provider regex) — never send a raw over-limit name (gemini)
   - `isWriteAction` / `requiresConfirmation` from binding override; **un-annotated default = `isWriteAction:true, requiresConfirmation:true`** (write-treatment until classified — opencode F2)
   - `handler = (args, ctx) => mcpClient.callTool(entry, tool, args)`
5. Inject these into the **same** `EngineMcpServer` tool set as native tools.
6. Entry unreachable/slow → **omit** its tools, emit `mcp_broker_degraded{entry}`, continue (FR-007).

## Invariants (the whole point)
- Every brokered call goes through `executeTool` → allow-list + per-tenant permission + audit. **0** direct un-brokered calls. (FR-004, SC-001)
- A brokered tool marked `isWrite` runs the **full** reserve→execute→finalize idempotency + confirm/dry-run + `action_audit` (010 T015) — identical to native writes. **Engine-side dispatch only** — the external mutation itself is NOT guaranteed idempotent (gemini F1); best-effort at the boundary, admins told to make write tools retry-safe. (FR-011, CQ3)
- Read brokered tool → audited `tools/call`, no idempotency reservation.
- Secrets decrypted only at connect; redacted in logs (FR-003). URLs SSRF-pinned at connect (FR-005).
- Tenant isolation: a persona only sees its own tenant's entries — broker query **JOINs on `tenant_id`** (+ DB CHECK `binding.tenant_id=entry.tenant_id`), not RLS alone. (FR-008, opencode F5)

## Acceptance
- **AC1**: persona bound to a registered MCP → its tool appears (namespaced) and a call is audited + permission-checked like native; un-bound server unreachable. (SC-001)
- **AC2**: a write-annotated external tool → reserve→execute→finalize + audit; double-call replayed not re-executed. (FR-011)
- **AC3**: bound MCP down → tools omitted, turn completes, `mcp_broker_degraded` emitted. (SC-002)
- **AC4**: second turn for same persona → `tools/list` served from cache (≤1 discovery / TTL window). (SC-005)
- **AC5**: external tool result with injected instructions stays inside `<untrusted_tool_result>`. (FR-009)
- **AC6**: cross-tenant — persona of tenant B cannot broker tenant A's entry. (SC-003)
