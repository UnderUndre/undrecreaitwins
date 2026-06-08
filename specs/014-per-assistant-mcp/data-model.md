# Data Model: Per-Assistant MCP Servers (014)

Two new Postgres tables (tenant-scoped + RLS) + runtime entities. Reviewed `.sql` migration only (Standing Order #5).

## Tables

### `mcp_catalog_entry` (tenant-scoped, RLS)
A vetted MCP server an admin registered.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid fk → tenants | RLS `app.current_tenant`; `ON DELETE CASCADE` |
| `scope` | enum `tenant`\|`platform` | stdio allowed only when `platform` (CQ4) |
| `name` | text | unique per `(tenant_id, name)`; validated `^[a-z0-9_-]+$` ≤20 chars (LLM tool-name limit, gemini F2); used in namespacing `mcp_<name>_<tool>` |
| `transport` | enum `http`\|`stdio` | tenant entries MUST be `http` (FR-006) |
| `url` | text null | http transport |
| `command` / `args` | text / jsonb null | stdio (platform only) |
| `auth_ciphertext` / `auth_ref` | bytea / text null | encrypted MCP auth headers (011 KMS); never returned/logged (FR-003) |
| `tools_include` / `tools_exclude` | jsonb null | server-level tool filter |
| `timeout_ms` | int default 30000 | connect+call bound |
| `tls_verify` | bool default true | + optional `client_cert` ref (mTLS) |
| `enabled` | bool default true | |
| `created_at`/`updated_at` | timestamptz | |

### `assistant_mcp_binding`
Which catalog entries an assistant uses + per-tool overrides.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid fk → tenants | RLS; `ON DELETE CASCADE` |
| `persona_id` | uuid fk → personas | `ON DELETE CASCADE` |
| `catalog_entry_id` | uuid fk → mcp_catalog_entry | `ON DELETE CASCADE`; unique `(persona_id, catalog_entry_id)` |
| `enabled` | bool default true | |
| `tool_overrides` | jsonb | per-tool `{ name, include, isWrite, requiresConfirmation }[]` (CQ3 annotation, research §c) |
| `created_at`/`updated_at` | timestamptz | |

> CASCADE everywhere (codex-review lesson from PR #24): deleting a tenant/persona/entry must not orphan bindings.
> **Tenant-match** (opencode F5): CHECK / composite-FK `binding.tenant_id = catalog_entry.tenant_id` — a binding may only reference a same-tenant entry; the broker query JOINs on `tenant_id` (don't trust RLS alone).

## Runtime entities (not persisted)

### Brokered Tool
A discovered external tool surfaced through the gateway.
- Built from: catalog entry + discovered MCP tool schema + binding override.
- Maps to the existing `ToolDefinition { name: 'mcp_<entry>_<tool>', description, parameters, isWriteAction, requiresConfirmation, handler }`.
- `handler` = call the external MCP via `mcp-client.ts` (`tools/call`), preserving the `<untrusted_tool_result>` fence (FR-009).
- `isWriteAction` / `requiresConfirmation` from binding annotation; **un-annotated default = `isWriteAction: true, requiresConfirmation: true`** (write-treatment until classified — closes the double-execute hole, opencode F2 / analyze F3).

### Discovery Cache Entry
- Key: `catalog_entry_id`. Value: discovered tool list + fetched-at. TTL-bounded; refresh on expiry/rescan. Discovery only — calls always live (FR-013).

### Broker Health (per turn)
- Per enabled entry: `reachable | degraded(reason)`. Degraded → tools omitted, `mcp_broker_degraded{entry}` signal, turn proceeds (FR-007).

## State transitions

```
session build → for each enabled binding:
   connect(entry, SSRF-pinned, timeout) ──ok──▶ tools/list (cache) → synthesize ToolDefinitions → inject into gateway
                                          └─fail─▶ omit entry's tools + degraded signal (turn continues)

agent calls mcp_<entry>_<tool>  →  executeTool (gateway):
   allow-list + permission ──deny──▶ denied (audited)
                            └─ok──▶ isWrite? ── reserve→execute(tools/call)→finalize (idempotency+audit)   [write]
                                              └─ tools/call → result (audited)                              [read]
```

## Isolation & secrets
- Catalog entries + bindings are tenant-scoped via RLS (`withTenantContext`) — no cross-tenant read (FR-008).
- Auth secrets encrypted at rest (011 KMS); decrypted only at connect; redacted in logs (FR-003).
