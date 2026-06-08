# Project Architecture

> Headless multi-tenant AI-twin engine (`undrecreaitwins`). Topography + data flow. Living spec — update when the shape changes.

## 1. Monorepo Structure

| Package | Role |
|---------|------|
| `packages/shared` | Common types, errors, utils — incl. canonical `ChannelAdapter`/`ChannelMessage`, `StreamChunk` |
| `packages/core` | Business logic, Drizzle models (incl. `agent_runs`, `action_audit`), services (chat, embedding, annotation, document, grounding, reengagement, langfuse, **hermes**: executor/hermes-adapter(ACP client)/mcp-server(tool-gateway over MCP)/tool-gateway/guardrail/turn-router/agent-lifecycle/honcho-client), `ChannelTransport`, `withTenantContext` |
| `packages/api` | Fastify REST (`/v1/...`), route wiring via `buildServer()` |
| `packages/memory` | Letta-based memory (**legacy**) — superseded by **Honcho** for agentic working-memory (010); kept until migrated off |
| `packages/training` | BullMQ workers (document parse → chunk → embed) |
| `packages/channel-telegram` | Telegram **Bot API** adapter |
| `packages/channel-whatsapp` | WhatsApp adapter (Evolution API backing) |
| `packages/channel-telegram-mtproto` | Telegram **userbot** adapter (GramJS / MTProto) — spec 006 |
| `packages/cli` | `twin` CLI |
| `infra/` | docker-compose (`standalone` / `with-orchestra`) + Dockerfiles |

Channel packages are **standalone workers**: each implements the shared `ChannelAdapter` and bridges to the engine via `ChannelTransport` (Redis Streams `INBOUND`/`OUTBOUND`) — not in-process to the API.

## 2. Substrate (decided 2026-05/06)

| Concern | Choice | Notes |
|---------|--------|-------|
| DB | PostgreSQL + **pgvector** | annotations + document_chunks vectors. **Qdrant dropped** — one store |
| Embeddings + rerank | **BGE-M3** + **BGE-reranker-v2-m3** via a **TEI sidecar** (HTTP, `EMBEDDINGS_URL`) | multilingual incl. Russian |
| Retrieval | **vector (HNSW cosine) + reranker** | hybrid / full-text **deferred** (no tsvector/GIN yet) |
| Queue / cron | **Redis + BullMQ** | document parse, re-engagement scan |
| Channel transport | **Redis Streams** (`ChannelTransport`) | INBOUND/OUTBOUND between adapters ↔ engine |
| Tenant isolation | **Postgres RLS** on `app.current_tenant` (set by `withTenantContext`) | mandatory |
| Observability / eval | **Langfuse** (self-host, its own compose) | trace per reply, fire-and-forget, project-per-tenant |
| LLM gateway | OmniRoute (orchestra) / OpenAI-compatible | `LLM_PROVIDER_URL` |
| Doc parsing | **officeParser** (TS-native) | PDF/DOCX/TXT |
| AI execution (agentic) | self-host **hermes-agent** (MIT) + **Honcho** working-memory | agentic turns (010); engine = orchestrator + guardrail; **supersedes Letta** for memory |
| Per-assistant LLM provider | **BYOK** custom OpenAI-compatible per assistant / tenant-default (011) | injected into Hermes via a throwaway `HERMES_HOME` profile (config.yaml + `OPENAI_API_KEY`); key encrypted at rest; `base_url` SSRF-pinned (undici dispatcher) |

## 3. Core Service Patterns

- **Repositories**: Drizzle CRUD, tenant-scoped via `withTenantContext(tenantId, fn)`.
- **Services**: `chat` (reply path + streaming), `embedding` (TEI client), `annotation` (few-shot loop), `document` (parse/chunk/embed), `grounding` (RAG retrieval), `reengagement` (scan/worker), `langfuse` (trace emit), **`hermes`** (agentic: `runAgentTurn` via self-host hermes-agent; engine-mediated tool-gateway = allow-list + per-tenant write-permission + `reserve→execute→finalize` idempotency + audit; validators/guardrail outbound gate + fallback; Honcho working-memory; spawn/hibernate lifecycle).
- **Middleware**: auth (Bearer, server-to-server), tenant resolution, error handling.
- **Reply path** (`ChatService.buildSystemPrompt` → `complete`): KB/RAG context → annotation few-shot (pre-gen, fail-open on embedder outage) → generate → stream (002) or `complete()` → persist + Langfuse emit.

## 4. Data Flow

- **Inbound (channel)**: adapter → `ChannelTransport.publish(INBOUND)` → engine consumes → `ChatService` reply → `publish(OUTBOUND)` → adapter `send()`.
- **API**: request → tenant middleware → `packages/api` → `core` services → models + RAG (pgvector) + memory (**Honcho** for agentic; Letta legacy) → response (JSON or SSE stream, spec 002).
- **Async**: document upload → BullMQ (`training`) parse→chunk→embed→pgvector; re-engagement → BullMQ scan cron + DB-status-claim worker → hook via `OUTBOUND`.
- **Agentic (010)**: agent-enabled persona → `turn-router` (scripted→deterministic; else→Hermes) → `runAgentTurn` (self-host hermes-agent) → tool-gateway (allow-list + permission + `reserve→execute→finalize` idempotency + `action_audit`) → validators (004) outbound gate → persist `agent_runs` + meter (007); Hermes outage / `maxExecutionMs` timeout → fallback to thin completion (fail-open).

## 5. Feature Tracking (engine specs)

| Spec | Summary |
|------|---------|
| 001-twin-engine-foundation | Persona CRUD, chat completions, tenant isolation |
| 002-streaming-completions | Real token-by-token SSE streaming + usage accounting + abort |
| 003-script-funnels | Scripted dialog runtime (deterministic matching, stages, slots) |
| 004-validators | Response/input validators (false-promise, format-injection) — sync pipeline |
| 005-fact-grounding | RAG runtime: pgvector + BGE-M3 + reranker; ingest delegated to 008 substrate |
| 006-mtproto-channel | Telegram userbot adapter (GramJS); shared `ChannelAdapter` + Redis-Streams transport; secrets via resolver; FloodWait/migration policy; idempotency |
| 008-agent-builder | Annotation→few-shot feedback loop + doc RAG + Langfuse adoption; builder/sandbox **FE delegated to Product** (010) |
| 009-reengagement-runtime | Dormant-conversation scanner + hook delivery (BullMQ scan + DB-status-claim worker + Redis Streams); idempotent, anti-spam |
| 010-hermes-executor | **Hermes** as agentic LLM backend (Topology C hybrid; always-agent for non-scripted; real write-actions; self-host MIT). Engine = orchestrator + SoR + guardrail (validators / tool-gateway / anti-spam / metering); Honcho working-memory + Postgres SoR |
| 011-llm-configuration | **Per-assistant BYOK LLM provider** (custom OpenAI-compatible: `base_url` + encrypted key + model + temperature/max_tokens). Resolves `assistant → tenant → platform`; injected into Hermes per spawn via a throwaway `HERMES_HOME` profile (`config.yaml` model.* + `OPENAI_API_KEY` env, never on disk; verified vs hermes-agent v0.15.1); `base_url` SSRF-guarded (DNS-resolve-and-pin via undici dispatcher); key encrypted at rest. Admin UI = Product (`ai-twins/011`). **Live path = thin completion** (`LLMClient.complete`); the agentic executor (`runAgentTurn`) is not yet wired. Durable-retry (US2) **deferred** → `specs/011-llm-configuration/followup-Y-durable-retry.md` |
| 013-agentic-runtime-readiness | **Runtime readiness for the 010 agentic loop.** (1) Engine image now carries the **Hermes CLI** — converted `packages/api/Dockerfile` (Node 20 + Python 3.11 + `pipx hermes-agent[acp]==0.15.1`) **and** a documented host-prereq path; **startup preflight** (`hermes acp --check` + ACP protocolVersion) fails at boot, not on first turn. (2) `honcho-client.ts` migrated from legacy `apps/users` → **Honcho v3** (`workspaces/peers`, workspace-per-tenant) so working memory persists instead of silent no-op; degradation now **observable** (transient vs permanent API mismatch). No DB change. Engine-only (worker/channel Dockerfiles deferred) |
| 014-per-assistant-mcp | **Per-assistant external MCP servers, brokered.** Tenant-admin curates a catalog of vetted **HTTP** MCP servers (stdio = platform-admin only); per-assistant bindings. At a turn the engine acts as an MCP **client**, discovers external tools (TTL-cached), and **re-exposes them through the engine gateway** (010) — same allow-list + permission + audit + **full write-treatment** (010 T015) for external writes. **No raw `session/new` passthrough** (preserves 010 gateway-as-sole-authority). Reuses 011 KMS (encrypted MCP auth) + SSRF-pin. New tables `mcp_catalog_entry` + `assistant_mcp_binding` (RLS). Admin UI = Product (`ai-twins`) |

## 6. Cross-repo boundary (runtime ↔ admin)

Engine (`undrecreaitwins`) owns the **RUNTIME**; Product (`ai-twins`) owns the **ADMIN/UI**, per the split pattern:

| Engine (undrecreaitwins) | Product (ai-twins) |
|--------------------------|--------------------|
| 003-script-funnels | 002-funnel-editor |
| 004-validators | 008-validator-admin |
| 006-mtproto-channel | 005-mtproto-session |
| 008-agent-builder | 010-agent-builder-admin |
| 009-reengagement-runtime | 006-reengagement-admin |

Product → engine is **server-to-server** (Bearer + `X-Tenant-ID`, via a Product BFF); engine RLS enforces tenant isolation. Shared tables with singular migration ownership (e.g. `followup_*` for re-engagement) coordinated cross-repo before either side migrates.

- [012-openai-endpoint](../012-openai-endpoint/spec.md): Public OpenAI-compatible endpoint with per-workspace API keys (Runtime).
