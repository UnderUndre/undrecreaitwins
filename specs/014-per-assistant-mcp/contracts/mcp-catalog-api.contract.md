# Contract: MCP Catalog + Binding API

**Scope**: `packages/api/src/routes/mcp-catalog.ts`, registered in `buildServer()`. Inline Zod, typed `AppError`, tenant-scoped via existing middleware (`request.tenantId` — NOT raw header, per PR #23 lesson). Admin UI (ai-twins) drives these.

## Endpoints

| Method | Path | Body / Result | Notes |
|---|---|---|---|
| `GET` | `/v1/mcp/catalog` | → `{ data: CatalogEntry[] }` | tenant-scoped; secrets **never** returned (only `has_auth: boolean`) |
| `POST` | `/v1/mcp/catalog` | `{ name, transport:'http', url, auth?, tools_include?, tools_exclude?, timeout_ms?, tls_verify? }` → `CatalogEntry` | validate `name` `^[a-z0-9_-]+$` ≤20 chars (LLM tool-name limit, gemini F2); SSRF-validate `url` (FR-005); encrypt `auth` (FR-003); `transport:'stdio'` rejected unless platform-admin (FR-006); `tools_include/exclude` = **exact-match** names v1 (opencode F10) |
| `PATCH` | `/v1/mcp/catalog/:id` | partial → `CatalogEntry` | re-SSRF-validate on url change |
| `DELETE` | `/v1/mcp/catalog/:id` | → 204 | CASCADE removes bindings |
| `POST` | `/v1/mcp/catalog/:id/rescan` | → `{ tools: DiscoveredTool[] }` | live `tools/list`; refreshes cache (does **not** interrupt in-flight turns — next turn picks up fresh, opencode F9); admin classifies isWrite per tool |
| `GET` | `/v1/assistants/:personaId/mcp` | → `{ bindings: Binding[] }` | which entries enabled + overrides |
| `PUT` | `/v1/assistants/:personaId/mcp` | `{ bindings: [{ catalog_entry_id, enabled, tool_overrides[] }] }` | replace bindings for the persona |

## Rules

- **Tenant scope**: every query inside `withTenantContext(request.tenantId, …)`; cross-tenant id → `NotFoundError` (not 403 — no existence leak). (FR-008)
- **Secrets**: `auth` accepted on write, encrypted (011 KMS), **never** echoed; responses expose `has_auth` only. Logs redact. (FR-003)
- **SSRF**: `url` validated (DNS-resolve-and-pin, private/loopback blocked) at POST/PATCH; re-checked at connect, **connecting to the pinned IP not the hostname** (DNS-rebinding, opencode F1). (FR-005)
- **stdio**: `transport:'stdio'` / `command` only when the caller is platform-admin AND `scope='platform'`; tenant callers → `ValidationError`. (FR-006, CQ4)
- **Validation**: Zod on every body; bad input → `ValidationError`.

## Acceptance
- **AC1**: POST with a private-IP url → rejected (SSRF) at registration. (SC-004)
- **AC2**: GET never returns auth secret (only `has_auth`); logs contain no secret. (FR-003)
- **AC3**: tenant B cannot GET/PATCH/DELETE tenant A's entry (NotFound). (SC-003)
- **AC4**: tenant caller sending `transport:'stdio'` → ValidationError. (FR-006)
- **AC5**: PUT bindings with per-tool `isWrite:true` → that tool later runs through write-treatment (see broker contract).
