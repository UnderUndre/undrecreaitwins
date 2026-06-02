# Project Architecture

> Headless multi-tenant AI-twin engine (`undrecreaitwins`). Topography + data flow. Living spec — update when the shape changes.

## 1. Monorepo Structure

| Package | Role |
|---------|------|
| `packages/shared` | Common types, errors, utils — incl. canonical `ChannelAdapter`/`ChannelMessage`, `StreamChunk` |
| `packages/core` | Business logic, Drizzle models, services (chat, embedding, annotation, document, grounding, reengagement, langfuse), `ChannelTransport`, `withTenantContext` |
| `packages/api` | Fastify REST (`/v1/...`), route wiring via `buildServer()` |
| `packages/memory` | Letta-based conversational/personality memory |
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

## 3. Core Service Patterns

- **Repositories**: Drizzle CRUD, tenant-scoped via `withTenantContext(tenantId, fn)`.
- **Services**: `chat` (reply path + streaming), `embedding` (TEI client), `annotation` (few-shot loop), `document` (parse/chunk/embed), `grounding` (RAG retrieval), `reengagement` (scan/worker), `langfuse` (trace emit).
- **Middleware**: auth (Bearer, server-to-server), tenant resolution, error handling.
- **Reply path** (`ChatService.buildSystemPrompt` → `complete`): KB/RAG context → annotation few-shot (pre-gen, fail-open on embedder outage) → generate → stream (002) or `complete()` → persist + Langfuse emit.

## 4. Data Flow

- **Inbound (channel)**: adapter → `ChannelTransport.publish(INBOUND)` → engine consumes → `ChatService` reply → `publish(OUTBOUND)` → adapter `send()`.
- **API**: request → tenant middleware → `packages/api` → `core` services → models + RAG (pgvector) + memory (Letta) → response (JSON or SSE stream, spec 002).
- **Async**: document upload → BullMQ (`training`) parse→chunk→embed→pgvector; re-engagement → BullMQ scan cron + DB-status-claim worker → hook via `OUTBOUND`.

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
