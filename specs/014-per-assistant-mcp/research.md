# Research: Per-Assistant MCP Servers (014)

**Phase 0.** CQ1–CQ4 already resolved in spec (clarify). This resolves the *mechanics*: engine-as-MCP-client, broker re-expose, read/write annotation, discovery caching, reuse of 010/011, data model.

## (a) Engine as MCP client — hand-rolled minimal client (no new dep)

The engine's [mcp-server.ts](../../packages/core/src/services/hermes/mcp-server.ts) is a **hand-rolled JSON-RPC MCP server** (NOT `@modelcontextprotocol/sdk`). For the external hop the engine must be an MCP **client** (`initialize` → `tools/list` → `tools/call` over HTTP).

**Decision**: hand-roll a **minimal MCP client** (`mcp-client.ts`) mirroring the existing server style — avoids a new runtime dependency (Standing Order #2) and matches house style. *(Alternative: add `@modelcontextprotocol/sdk` Client — fuller protocol coverage, but needs dependency approval; flagged, not chosen for v1.)* ⚠ Confidence ~0.8 the minimal client covers real-world HTTP MCP servers — **verify against ≥1 real server in a smoke** before broad use.

## (b) Broker re-expose — merge external tools INTO the existing gateway

At session build (where `hermes-executor` constructs the `EngineMcpServer` config), the broker:
1. for each **enabled** catalog entry on the persona → connect (client) → `tools/list` (cached, §d);
2. for each discovered tool, synthesize a `ToolDefinition` whose `handler` performs the external `tools/call`, and **inject it into the SAME `EngineMcpServer` tool set**, namespaced `mcp_<entryName>_<tool>`.

So the agent still sees **one** MCP (the gateway). Every external tool flows through `executeTool` → allow-list + per-tenant permission + audit + write-action. **No second `session/new.mcpServers` entry.** (FR-004, FR-010)

## (c) Read vs write — MCP tool schemas don't declare it

MCP carries no read/write flag on tools. So **the admin annotates** per discovered tool: `isWrite` / `requiresConfirmation`, stored on the binding (extends the existing `ToolAllowEntry {id,isWrite,requiresConfirmation}`). **Default for an un-annotated external tool = `isWrite: true`, `requiresConfirmation: true`** (write-treatment until an admin classifies it — confirm-gate alone does NOT prevent double-execute on retry; opencode F2). A tool marked read after review drops the idempotency reservation. (FR-011, CQ3)

**Idempotency scope (gemini F1)**: reserve→execute→finalize makes the **engine-side dispatch** idempotent; it can NOT make a black-box external mutation idempotent (drop mid-execute → external changed, no finalize). Best-effort at the engine boundary; the admin UX must tell tenants to make external write tools retry-safe.

## (d) Discovery caching — TTL keyed by entry

`tools/list` per turn = N+1 against external servers (the 013 honcho lesson). **Decision**: in-process TTL cache keyed by catalog-entry id, bounded; refresh on TTL expiry or an explicit admin "rescan". Cache **discovery only** — tool *calls* are always live. Multi-entry cache-miss discovery runs **concurrently** (bounded `Promise.allSettled`), not sequentially (gemini F3 / opencode F6). Invalidate an entry's cache on a call-time `tool not found`/`invalid params` (schema drift, opencode F8). (FR-013, SC-005)

## (e) Secrets + SSRF — reuse 011

- MCP auth (headers) encrypted at rest via the **011 KMS envelope** (same decrypt path as BYOK keys); never logged — tool-gateway already redacts `token|authorization|secret|key` arg keys.
- Engine→external HTTP uses **011's SSRF DNS-resolve-and-pin undici dispatcher** at **both** registration-validation and connect time — connecting to the **pinned IP, not re-resolving the hostname** (DNS-rebinding defense, opencode F1). Client caps response size (~1 MB) to avoid OOM from a hostile server (gemini F4). (FR-003, FR-005, FR-014)

## (f) Failure / health — degrade, don't fail

External MCP unreachable/slow at session build → that entry's tools are omitted for the turn (logged + per-turn health signal `mcp_broker_degraded{entry}`); the turn proceeds with native + reachable tools. Connect bounded by `entry.timeout`. (FR-007, SC-002)

## (g) Data model — 2 tables, tenant-scoped, RLS

- **`mcp_catalog_entry`** (tenant-scoped, RLS): `scope` (tenant|platform), `transport` (http|stdio), `url`/`command`+`args`, `auth_ciphertext`+`auth_ref` (encrypted), `tools_include`/`tools_exclude`, `timeout`, `tls` (ssl_verify/client_cert), `enabled`. **stdio fields settable only when `scope='platform'`** (CQ4).
- **`assistant_mcp_binding`**: persona ↔ entry, `enabled`, `tool_overrides` jsonb (per-tool `isWrite`/`requiresConfirmation`/include).
- New tables → re-export in `models/index.ts` + relations; reviewed **`.sql` migration** (Standing Order #5), with **RLS** mirroring existing tenant tables.

## (h) Cross-repo admin

Engine (014) exposes the config API (`/v1/mcp/catalog`, `/v1/assistants/:id/mcp`); admin UI lives in **ai-twins** next to the 011 llm-provider screens. This spec owns runtime + API + storage only.

## Open items to tasks

- [a] Smoke the minimal MCP client against a real HTTP MCP before broad use; escalate to the SDK (dep-approval) only if coverage is insufficient.
- [c] Confirm "un-annotated external tool ⇒ confirm-gated" is acceptable product UX.
- [g] stdio platform-admin path needs process-spawn sandboxing — schema allows it, but hardening is its own slice.
