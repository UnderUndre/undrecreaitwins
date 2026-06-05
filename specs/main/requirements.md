# Project Requirements

## 1. Vision
Open-source headless AI-clone (digital twin) backend. **Multi-tenant from day one** (hundreds of tenants).

## 2. Technical Stack

### 2.1 Core
- **Language**: TypeScript (Node.js >= 20, strict ESM)
- **Framework**: Fastify (REST `/v1`, SSE for streaming)
- **Database**: PostgreSQL + **pgvector** (via Drizzle ORM)
- **Cache / Queue / Transport**: Redis — ioredis + **BullMQ**; **Redis Streams** for channel transport
- **Logging**: Pino · **Validation**: Zod

### 2.2 AI / Memory / RAG
- **Vector store**: **pgvector** on the primary Postgres (HNSW cosine). **Qdrant dropped** — single store, no second RAG stack.
- **Embeddings + rerank**: **BGE-M3** (embed) + **BGE-reranker-v2-m3** (rerank) via a **TEI sidecar** over HTTP (`EMBEDDINGS_URL`). Multilingual incl. Russian.
- **Retrieval**: vector + reranker (hybrid / full-text **deferred** until keyword recall demands it).
- **Memory**: **Honcho** (agent working / user-model memory; reconstructible from Postgres SoR; `HONCHO_URL`) — supersedes Letta (010-hermes-executor).
- **Agentic executor**: self-host **hermes-agent** (MIT) as the agentic LLM backend (spec 010) — plan→tool→observe; **engine-mediated tool-gateway** (allow-list + per-tenant write-permission + `reserve→execute→finalize` idempotency + `action_audit`); validators outbound gate; fail-open fallback to thin completion. Integration = **ACP** (engine spawns `hermes acp`) + **engine-hosted HTTP MCP server** (tool-gateway). Env: `HERMES_ACP_CMD`, `ENGINE_MCP_SECRET`, `ENGINE_MCP_PORT`, `AGENT_MAX_EXECUTION_MS`, `AGENT_LOOP_CAP`, `HONCHO_URL`.
- **LLM gateway**: OmniRoute / OpenAI-compatible provider (`LLM_PROVIDER_URL`) — the platform default.
- **Per-assistant LLM provider (BYOK, 011)**: each assistant / tenant-default may run on its own **custom OpenAI-compatible** provider (`base_url` + encrypted key + model id + temperature/max_tokens); resolves `assistant → tenant → platform default`; injected into Hermes per spawn via a throwaway `HERMES_HOME` profile (`config.yaml` model.* + `OPENAI_API_KEY` env, never on disk; verified vs hermes-agent v0.15.1); key **encrypted at rest**; `base_url` **SSRF-guarded** (DNS-resolve-and-pin via undici dispatcher). Live path today = thin completion (`LLMClient.complete`); the agentic executor (`runAgentTurn`) is not yet wired. Admin UI = Product (`ai-twins/011`).
- **Observability / eval**: **Langfuse** (self-host) — trace per reply, fire-and-forget, project-per-tenant.
- **Doc parsing**: officeParser (TS-native) — PDF/DOCX/TXT.

### 2.3 Channels
Standalone `ChannelAdapter` workers bridged to the engine via `ChannelTransport` (Redis Streams): **Telegram Bot API**, **WhatsApp** (Evolution API), **Telegram MTProto userbot** (GramJS).

### 2.4 Quality
- **Testing**: Vitest (unit + integration) · **Linting**: ESLint/Prettier · **Typing**: strict TS.

## 3. Constraints
- **Multi-tenant isolation is mandatory** — Postgres **RLS** keyed on `app.current_tenant` (set by `withTenantContext`); every query tenant-scoped.
- **Secrets** (LLM/engine keys, channel session strings) — server-side only; never in logs, code, or client bundle.
- **Migrations** — reviewed `.sql`, never auto-applied.
- **Idempotency** for async/state mutations — unique constraints + atomic status claims; **no check-then-insert** (race → double-send).
- **Engine = server-to-server** — Bearer required, no anonymous access (makes trust flags like `isTestThread` reliable).
- Optimistic locking for stateful config mutations (versioning) where the engine owns the record.

## 4. Non-Functional (cross-cutting)
- Streaming reply path (002): non-blocking event loop, bounded in-flight buffer, abort on client disconnect.
- RAG/annotation retrieval (005/008): adds < 300 ms to reply; few-shot **fails open** on embedder/TEI outage (chat survives).
- Re-engagement (009): no double-send (idempotency key + atomic claim), stuck-`processing` recovery (timeout sweep), cross-rule anti-spam (minInterval), worker concurrency for throughput.
- Channels (006): FloodWait/DC-migration policy, inbound eligibility/loop-prevention, encrypted session handling.
- Agentic executor (010): per-tenant cost + loop/token cap + hard `maxExecutionMs` → **fail-open** to thin completion; write-actions **crash-durable** (`reserve→execute→finalize`, no double-write under retry/crash); per-`(tenant,persona,conversation)` session isolation; secrets never reach the agent (engine tool-gateway holds creds); every answer through the validators (004) gate.
- Per-assistant provider (011): user-supplied `base_url` is an egress sink → **SSRF-guarded** (reject loopback/private/link-local/cloud-metadata; **DNS-resolve-and-pin via undici dispatcher** — global `fetch` ignores `node:http`/`node:https` Agents); BYOK key **encrypted at rest**, decrypted only at injection, never logged / cross-tenant; pooled Hermes process never serves a stale/foreign config. Durable-retry on provider outage (US2 "no message loss") **deferred** → `specs/011-llm-configuration/followup-Y-durable-retry.md` (do **not** wire enqueue without delivery — would regress the 010 fail-open fallback).
