# Project Spec — `undrecreaitwins` (Engine)

> **Living spec.** Source of truth: code (`packages/`, `drizzle/`) + Drizzle schema. Update when the shape changes. Architecture deep-dive: [`architecture.md`](architecture.md). Data details: [`data-model.md`](data-model.md). Constraints/NFRs: [`requirements.md`](requirements.md).

## 1. Vision

Open-source **headless multi-tenant AI-twin (digital twin) backend**. Multi-tenant from day one (hundreds of tenants). Owns the **RUNTIME**: chat reply path, RAG, agentic execution (Hermes), funnels, validators, tuning, memory, re-engagement, multi-channel transport. The Product layer (`ai-twins`) owns administration/UI.

## 2. Topography

pnpm monorepo (`pnpm@9.15.4`, Node ≥ 20, strict ESM).

| Package | Role |
|---------|------|
| [`packages/core`](../../packages/core) | Business logic, Drizzle models (in `src/models/`), services (in `src/services/`): Chat, Hermes (executor/adapter/mcp-server/tool-gateway/mcp-broker/guardrail/turn-router/agent-lifecycle/honcho-client), Grounding, Validators, DAR (correction-rules), Feedback, Funnel, Tuning, Reengagement, Langfuse. `ChannelTransport`, `withTenantContext`. |
| [`packages/api`](../../packages/api) | Fastify REST `/v1/*` + OpenAI-compatible public endpoint. `buildServer()` wiring. Port `PORT || 8090`. |
| [`packages/shared`](../../packages/shared) | Common types, errors, `REDIS_STREAMS`, storage-backend. |
| [`packages/memory`](../../packages/memory) | **Letta client (legacy)** — circuit-breaker. Superseded by Honcho for agentic working-memory. |
| [`packages/training`](../../packages/training) | BullMQ workers: training-jobs (parse → extract traits). |
| [`packages/embedding-adapter`](../../packages/embedding-adapter) | Optional TEI-to-cloud proxy (025) for low-RAM deploys. |
| [`packages/cli`](../../packages/cli) | `twin` CLI. |
| [`packages/channel-*`](../../packages) (16) | Channel adapters as **standalone workers**: telegram (Bot API), whatsapp (Evolution), telegram-mtproto (GramJS userbot), discord, slack, mattermost, matrix, email, sms, webhooks, vk, avito, dingtalk, feishu, wecom, homeassistant. |
| `infra/` | docker-compose (`standalone` / `with-orchestra`) + Dockerfiles. |
| `drizzle/` | 16 SQL migrations + `rls/001_enable_rls.sql`. |
| `deploy/channels/` | `Dockerfile.adapter` — generic adapter image. |

## 3. Substrate (decided)

| Concern | Choice |
|---------|--------|
| DB | PostgreSQL + **pgvector** (HNSW cosine). Qdrant dropped — single store. |
| ORM | **Drizzle**. |
| Embeddings + rerank | **BGE-M3** (1024-dim) + **BGE-reranker-v2-m3** via **TEI sidecar** (`EMBEDDINGS_URL`) OR **Embedding Adapter** (025, cloud proxy). |
| Retrieval | vector + reranker (default) OR **big-context** (028, full-text direct prompt injection). |
| Queue / cron | **Redis + BullMQ**. |
| Channel transport | **Redis Streams** (`ChannelTransport`): `INBOUND`/`OUTBOUND`. |
| Tenant isolation | **Postgres RLS** on `app.current_tenant` (set by `withTenantContext`). Mandatory. |
| Observability / eval | **Langfuse** (self-host, fire-and-forget, project-per-tenant). |
| LLM gateway | OmniRoute / OpenAI-compatible (`LLM_PROVIDER_URL`). |
| Per-assistant LLM | **BYOK** custom OpenAI-compatible per persona / tenant-default (011). Injected into Hermes via throwaway `HERMES_HOME` profile. Key encrypted at rest, `base_url` SSRF-pinned (undici dispatcher). |
| Agentic executor | self-host **hermes-agent** (MIT) + **Honcho** working-memory (010). Supersedes Letta. |
| Doc parsing | officeParser / mammoth / pdf-parse. `fullText` cache in DB for big-context. |
| Logging / Validation | Pino (redact) · Zod. |

## 4. Auth & Tenant Isolation

- **Server-to-server only**. `TWIN_AUTH_MODE` = `standalone` (default, Bearer) or `gateway`.
- Two `onRequest` hooks: (1) tenant resolution from `x-tenant-id` or base64url `x-tenant-claim` (auto-creates tenant idempotently); (2) Bearer auth against static token (`TWIN_AUTH_STATIC_TOKEN`) or `api_tokens` lookup (sha256). Tenant mismatch → 403.
- **Public API** (`sk-aitw_` prefix): bypasses both hooks, goes through `authPublicPlugin` (012).
- **RLS**: every query tenant-scoped via `withTenantContext(tenantId, fn)` which sets `app.current_tenant`.

## 5. REST API Surface (`packages/api/src/routes/`)

**Health**: `GET /v1/health` (status + checks: `database`, `hermes_runtime`, `honcho_memory`).

**Personas**: `POST /v1/personas` (+ `/v1/assistants` alias), `GET /v1/personas` (limit/offset), `GET|PATCH|DELETE /v1/personas/:id` (PATCH supports `If-Match`).

**Chat (internal)**: `POST /v1/chat/completions` (OpenAI-compatible, stream + non-stream, `model` = persona slug).

**Documents**: `POST /v1/assistants/:id/documents` (10MB, PDF/DOCX/TXT), `GET /v1/assistants/:id/documents`, `DELETE /v1/documents/:id`.

**Annotations**: `POST /v1/assistants/:id/annotations` (upsert + Langfuse dataset push), `DELETE /v1/annotations/:id`.

**Sandbox**: `POST /v1/sandbox/chat` (test reply, `isTestThread=true`).

**LLM Provider (BYOK, 011)**: `GET|PUT|DELETE /v1/llm-provider/tenant` (+ `/v1/tenant/llm-provider`), `GET|PUT|DELETE /v1/personas/:id/llm-provider`, `POST /v1/llm-provider/test`.

**MCP Catalog (014)**: `GET|POST /v1/mcp/catalog`, `PATCH|DELETE /v1/mcp/catalog/:id`, `POST /v1/mcp/catalog/:id/rescan`, `GET|PUT /v1/assistants/:personaId/mcp`, `GET /v1/mcp/health`.

**Channels**: `POST|GET /v1/channels` (13 types), `DELETE /v1/channels/:id`, `GET /v1/channels/health` (30s cache).

**Funnel**: `GET|PUT /v1/personas/:id/funnel`, `POST /v1/funnels`, `POST /v1/funnels/:id/versions`, `POST /v1/conversations/:id/funnel/reset`, `DELETE /v1/funnels/:id`.

**Tuning (026)**: `POST /v1/personas/:personaId/tuning/generate` (async 202), `GET /v1/tuning/drafts/:draftId`, `GET /v1/personas/:personaId/tuning/drafts`, `POST /v1/tuning/drafts/:draftId/{review,activate,rollback,sandbox-preview}`, `POST /v1/personas/:personaId/tuning/interview/{next,answer}`, `GET /v1/personas/:personaId/tuning/proposals`, `POST /v1/tuning/proposals/:proposalId/{accept,reject}`.

**Structured query (029)**: `POST /v1/personas/:personaId/structured-query` (docs in `user` role, `responseFormat: json_object`).

**Grounding admin (028)**: `PATCH /v1/documents/:id/priority`, `GET /v1/admin/model-windows`, `GET /v1/admin/grounding-status/:personaId`.

**Fallback / Behavior / Retry**: `GET|PUT /v1/personas/:id/fallback`, `GET|PUT /v1/personas/:id/behavior`, `GET /v1/retry-jobs`.

**Validators (017, 023, 024)**: `GET|PUT /v1/personas/:personaId/validators/language-guard`, `GET /v1/personas/:personaId/validators/language-guard/logs`.

**Internal**: `POST /v1/internal/rules-reload` (correction-rule cache invalidate), `GET /v1/internal/retrieved-feedback`.

**Tokens**: `POST /v1/tokens`, `DELETE /v1/tokens/:id`.

**Conversations**: `GET /v1/conversations`, `GET /v1/conversations/:id/messages`.

**Training**: `POST /v1/personas/:id/train` (202 async), `GET /v1/training-jobs/:id`.

**Public OpenAI (012)**: `GET /v1/models` (personas as `asst_<slug>`), `POST /v1/chat/completions` (model must start with `asst_`).

## 6. Core Services (`packages/core/src/services/`)

### ChatService (`chat-service.ts`, ~1600 LOC)
Central orchestrator. `complete()` (non-stream) + `completeStream()` (AsyncGenerator).
Flow: resolve persona (+ draft overlay) → **inbound sanitize** (format-injection) → find/create conversation → if channel: create `delivery_records` (state=pending), schedule soft-fallback via BullMQ → **Funnel processing** (`FunnelRuntime.processMessage`) → **turn routing** (`routeTurn`: scripted vs agentic) → agentic: `HermesExecutor.runAgentTurn()` + post `runAgenticLanguageGuard`; scripted: `buildSystemPrompt` + LLM call (60s hard-timeout for channels) → **post-gen validation**: `ResponseGuard.run()` OR `ValidatorPipeline.validateResponse()` + **DAR pipeline** → persist + Langfuse + usage event → **CAS delivery** for channels (cancel fallback, `tryCasFinalDelivery`, pacing hold, Redis OUTBOUND).

`buildSystemPrompt()` layers: persona base + traits → grounding (static: big-context `<documents>` OR vector top-5 after `ragRelevanceThreshold` 0.3; strict-RAG refusal) → annotation few-shot (threshold 0.7, top-3) → language directive (fail-open) → **feedback memory** (019, fail-open, replaces prompt parts) → funnel context (stage, slots, `{{slot}}` replacement).

### Hermes Executor (`hermes/`)
ACP-backed agent (spawns `hermes acp`). **Warm pool** keyed by `configHash` (LRU, `LLM_MAX_CONFIGS_PER_TENANT` default 8, idle TTL 15 min). **BYOK injection** via throwaway `HERMES_HOME` profile. Hard timeout `AGENT_MAX_EXECUTION_MS` (20000). Fallback to `LLMClient.complete` on timeout/spawn-fail/ACP-error. Per-turn MCP server start (`HttpMcpTransport`).

### MCP Tool-Gateway (`hermes/tool-gateway.ts`, `mcp-server.ts`, `mcp-broker.ts`)
Engine is the sole authority for tool execution. Allow-list + per-persona write-permission + `reserve→execute→finalize` idempotency (3 separate committed txns; no DB conn held during external call) + `action_audit`. Args redaction (token/password/secret/apiKey/key, 64KB cap). MCP HTTP transport on `ENGINE_MCP_PORT`, auth `X-Engine-MCP-Secret`.

### Grounding (`grounding/GroundingEngine.ts`, `retrieval.ts`)
Dual mode. Resolution: `personas.groundingMode` → `tenants.groundingMode` → `'vector'`.
- **Vector**: pgvector cosine + BGE-reranker (top-20 → filter 0.3 → top-5 → 2000-token budget). Fallback to vector-only on reranker outage.
- **Big-context (028)**: all `documents.fullText` packed into `<documents>` block (priority DESC). `BIG_CONTEXT_MAX_TOKENS` 8000, safety 5%. Truncation: `'silent'` (default) or `'fallback-vector'` (if `embeddingsStatus='completed'`). Warning if model window < 32000.

### Validators (`validators/pipeline.ts`)
Post-gen: `FalsePromiseValidator`, `LanguageGuardValidator`, `IdentityGuardValidator`. Pre-gen: `FormatInjectionValidator`. BLOCKING first, REWRITE last. Per-validator config from `validator_configs` (`enabled`, `mode:'active'|'dry-run'`). Single failure → error verdict, pipeline continues; pipeline failure → safest reply. Empty-output guard. Best-effort `validator_runs` audit (`SKIP_VALIDATOR_RUNS`).

### DAR Pipeline (`correction-rules/dar-pipeline.ts`)
Detect (regex/keyword structural + pattern/semantic LLM-batched ≤3) → Aggregate (scoreRules/rewriteRules, cap ≤4) → Rewrite (single LLM pass) → re-validate through 004 (rollback on violation) → push quality events (fail sync, rest via `setImmediate`). Fail-open.

### Feedback Retrieval (`feedback/feedback-retrieval.ts`, 019)
pgvector cosine on `feedback_memories` (status='active'). Score = `similarity * weight * recencyDecay * operatorRoleWeight` (half-life 30d; owner 1.5, admin 1.2). Threshold 0.75, top-K 3. Dedup via `conversation_feedback_states`. Fail-open.

### Tuning (`tuning/`, 026)
`DocExtractionPipeline`, `InterviewStateMachine` (Redis TTL 30min), `ConversationAnalyzer` (ephemeral proposals, Redis TTL 30min), `SandboxDraftMode` (ChatService overlay), `ActivatePipeline` (atomic persona+funnel+validator apply, `previousSnapshot` for rollback). `sweepStaleGenerating` (90s stall → failed).

### Funnel Runtime (`funnel/`)
`FunnelRuntime.processMessage()` (stage transitions, slot capture, fragment scoring via `FragmentScorer`). `ConditionEvaluator`, `VariableParser` (`{{name}}`), `Pacing` (transport-level `delay_ms`/`typing_chunks`). Repository: CRUD versions, conversation state, reset.

### Reengagement (`reengagement/`)
`ReengagementScanner` (batch 1000, conditions: source/tags, backoff array). `ReengagementWorker`: `processScheduledAttempts` (atomic claim `scheduled → processing` via `FOR UPDATE SKIP LOCKED`), `sweepStuckAttempts` (`processing → failed` after `TWIN_REENGAGE_CLAIM_TIMEOUT_MS` 5min). `ReengagementGenerator` (LLM hook, 30s timeout).

### LLM Provider / Retry / Delivery CAS (`llm-provider/`, `retry/`)
`resolveEffectiveConfig` (persona → tenant → platform). AES encrypt/decrypt API keys. SSRF guard (undici dispatcher DNS-pin). `ProviderRetryWorker` (retry transient errors, `isRetryableProviderError`). `tryCasFinalDelivery` (atomic UPDATE `delivery_records`). `llm-retry-worker` + `fallback-worker` for channel conversations.

## 7. Memory: Honcho + Letta

- **Honcho** (`hermes/honcho-client.ts`) — **primary**. API v3: workspaces/peers/sessions/messages/representation. Workspace = tenantId, peer = `p-{personaId}-u-{externalUserId}`, session = conversationId. `getInsights()`, `addMessage()`. Degradation signal classification (`'transient'|'permanent'`); server.ts updates `honchoMemoryStatus` → `/v1/health`.
- **Letta** (`packages/memory/letta-client.ts`) — **legacy/secondary**. Circuit breaker (5 failures → open, 60s half-open). Used in ChatService for conversation memory (`Memory context:` injection). Fail-open.

## 8. Channels Architecture

Standalone adapter workers ↔ core via **Redis Streams**.
- `INBOUND` (channel → core), `OUTBOUND` (core → channel).
- `ChannelTransport.publish/consume` (consumer groups, `XACK` on success, max 5 consecutive errors).
- `ChannelOrchestrator` (core INBOUND consumer): Redis dedup `dedup:{channel_id}:{message_id}`, calls `ChatService.complete()` with `channelContext`, CAS delivery, retryable provider error → `enqueueProviderRetry()`. CL-A7: OUTBOUND payload must not contain `stream`/`partial` flags.
- Adapters implement shared `ChannelAdapter`. CLI args: `--channel-id --bot-token --tenant-id --persona-slug --redis-url` (Telegram example).

## 9. Feature Tracking (engine specs)

See [`architecture.md`](architecture.md) §5 for the full table. Current: **001** foundation · **002** streaming · **003** script funnels · **004** validators · **005** fact grounding · **006** mtproto channel · **008** agent builder · **009** reengagement · **010** hermes executor · **011** LLM configuration · **012** openai endpoint · **013** agentic readiness · **014** per-assistant MCP · **015** multi-channel gateway · **016** marketplace comms · **017** language guard · **018** response quality rules · **019** feedback loop · **020** funnel richness · **021** CRAG consilium · **022** agentic memory v2 · **023/024** language guard leftovers/rewrite mirror · **025** embedding adapter · **026** tuning · **027** validators/quality convergence · **028** big-context LLM RAG.

## 10. Constraints

- **RLS mandatory** — every query tenant-scoped.
- Secrets server-side only; BYOK keys encrypted at rest, decrypted only at Hermes injection, never logged.
- Migrations = reviewed `.sql`, never auto-applied.
- Idempotency via unique constraints + atomic status claims; no check-then-insert.
- Optimistic locking (`version` BigInt/int + `If-Match`) for stateful config.
- Write-actions **crash-durable** (`reserve→execute→finalize`, no double-write under retry/crash).
- Hermes outage / `maxExecutionMs` → **fail-open** to thin completion.
- Every reply through validators gate (004) + DAR (018) → fail-open.
