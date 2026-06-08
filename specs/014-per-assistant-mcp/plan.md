# Implementation Plan: Per-Assistant MCP Servers (Brokered)

**Branch**: `specs/014-per-assistant-mcp` | **Date**: 2026-06-08 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/014-per-assistant-mcp/spec.md`

## Summary

Give each assistant extra external tools via MCP **without breaking 010's gateway-as-sole-authority**. The engine becomes an MCP **client** to vetted external servers, **brokers** their tools through its own MCP gateway (allow-list + per-tenant permission + audit + full write-action treatment), and never hands the agent a raw external `mcpServers` entry. Config is a tenant-scoped catalog + per-assistant bindings; secrets encrypted (011 KMS) and URLs SSRF-pinned (011 dispatcher).

## Technical Context

**Language/Version**: TypeScript on **Node 20**.
**Primary Dependencies**: Drizzle (2 new tables); reuse **011** (KMS envelope + SSRF undici dispatcher); extend **010** (`mcp-server.ts`, `tool-gateway.ts`, `hermes-executor.ts`); a new **hand-rolled minimal MCP client** (no new npm dep — Standing Order #2).
**Storage**: 2 new Postgres tables (`mcp_catalog_entry`, `assistant_mcp_binding`), tenant-scoped + RLS. Reviewed `.sql` migration only (Standing Order #5).
**Testing**: vitest (unit + integration with mocked external MCP) + **one real-HTTP-MCP smoke** for the client (research §a).
**Target Platform**: engine runtime (container/host from 013).
**Project Type**: backend service + config API; admin UI is cross-repo (ai-twins).
**Performance Goals**: external tool discovery cached (TTL) — **no per-turn N+1**; broker connect bounded by `entry.timeout`; off the reply critical path on failure (degrade).
**Constraints**: gateway = sole authority (no raw passthrough); RLS per-tenant; secrets encrypted + never logged; SSRF-pin at registration AND connect; external writes get full 010 write-treatment.
**Scale/Scope**: medium. The **heavy** part is routing external writes through the reserve→execute→finalize machinery (CQ3) — flag for staging.

## Constitution Check

This repo consumes the upstream `clai-helpers` constitution; **I–V/VIII** govern the template (N/A here). Applicable:
- **VI Cross-AI Review Gate (NON-NEGOTIABLE)** → honored downstream (analyze + ≥2 external PASS before implement).
- **VII Artifact Versioning** → branch exists; snapshot/commit deferred pending consent (Standing Order #1), as with 013.
- **Standing Orders**: no new dep (hand-rolled client); migration = reviewed `.sql`; no secrets in code/logs; pin behavior.

**Result**: PASS, 0 violations. Complexity Tracking: the external-write machinery is justified by CQ3 (not gratuitous).

## Project Structure

```text
packages/core/src/services/hermes/
├── mcp-client.ts            # NEW — minimal JSON-RPC MCP client (initialize/tools.list/tools.call over HTTP), SSRF-pinned
├── mcp-broker.ts            # NEW — per-persona: resolve bindings → discover (cached) → synthesize ToolDefinitions → inject
├── mcp-server.ts            # EXTEND — accept brokered tools alongside native
├── tool-gateway.ts          # EXTEND — brokered ToolDefinition; isWrite/requiresConfirmation from binding annotation
└── hermes-executor.ts       # EXTEND — build broker into the EngineMcpServer config at session start

packages/core/src/models/
├── mcp-catalog-entry.ts     # NEW (tenant-scoped, RLS; scope tenant|platform; encrypted auth; stdio platform-only)
├── assistant-mcp-binding.ts # NEW (persona ↔ entry + per-tool overrides)
├── index.ts                 # EXTEND (re-export)
└── relations.ts             # EXTEND

packages/api/src/
├── routes/mcp-catalog.ts    # NEW — /v1/mcp/catalog CRUD + /v1/assistants/:id/mcp bindings (inline Zod, AppError)
└── server.ts                # EXTEND — register route in buildServer()

drizzle/00NN_per_assistant_mcp.sql   # NEW — reviewed migration (tables + RLS + indexes)

specs/main/architecture.md           # update: 014 row
```

**Structure Decision**: extend the existing 010 hermes service (no parallel path) + 2 new models + 1 config route + a hand-rolled MCP client. Admin UI is out-of-repo (ai-twins). The broker is the single new moving part; everything else reuses 010/011.

## Complexity Tracking

| Item | Why needed | Simpler rejected because |
|------|------------|--------------------------|
| Full write-treatment for external tools | CQ3 (user decision) | read-only would've been simpler but the team chose parity with native writes |
| Hand-rolled MCP client | avoid new dep (Standing Order #2) + match house style | the SDK is cleaner but needs approval + adds supply-chain surface |
