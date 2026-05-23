# Feature Specification: Twin Engine Foundation

**Feature Branch**: `001-twin-engine-foundation`
**Created**: 2026-05-23
**Status**: Draft (Clarified)
**Input**: User description: "Open-source headless AI-clone (digital twin) backend. Multi-tenant primitives. Core conversation API with REST + SSE + OpenAI-compatible endpoint. Persona stored in Postgres, runtime CRUD. Memory via Letta. RAG via Qdrant. Real-time channel adapters (Telegram, WhatsApp/Evolution API) as opt-in packages communicating with core via Redis pub/sub. Twin training pipeline from chat logs (Telegram JSON/WhatsApp TXT) included in v1. Built on top of undrestrator orchestra (OmniRoute LLM gateway + Hermes runtime + Qdrant + Redis). Apache 2.0 license. Consumers: Dvoiniki SaaS shell, third-party self-hosters, CLI users."

---

## Scope & Boundaries

### IN scope (this spec / v1)

- Headless backend — REST + SSE + OpenAI-compatible API
- Persona CRUD (Postgres-backed)
- Conversation orchestration (delegating LLM calls to OmniRoute, memory to Letta)
- Per-persona RAG via Qdrant (tenant-namespaced collections)
- Real-time channel adapters: **Telegram** (Telegraf-based) and **WhatsApp** (Evolution API client) — shipped as separate npm packages in monorepo
- Twin training pipeline — Telegram JSON exports + WhatsApp TXT exports
- Multi-tenant primitives — `tenant_id` propagation, isolation invariants, but NO auth UI / billing UI (that's Dvoiniki SaaS shell)
- CLI `twin` for setup, persona management, training, channel control
- Docker Compose for standalone and orchestra-integrated deployment

### OUT of scope (later versions or different repos)

- Frontend UI / admin panel → Dvoiniki SaaS shell
- Multi-tenant auth (Keycloak/Better-Auth) → Dvoiniki SaaS shell
- Billing & usage metering UI → Dvoiniki SaaS shell (twin-engine emits raw metering events to OmniRoute/OpenMeter)
- Voice channels (LiveKit Agents) → v2 as `packages/channel-voice`
- Avatar / video generation (LivePortrait, etc) → v2+
- Email inbound (Postal integration) → v2 as `packages/channel-email`
- Discord/Slack/Signal — Hermes from orchestra already provides these for the SaaS shell; not duplicated in twin-engine core
- CRM-specific integrations (AmoCRM, Bitrix24, HubSpot) → Dvoiniki SaaS shell (via n8n internal glue)

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Create and chat with a digital twin via API (Priority: P1)

A developer (or Dvoiniki SaaS backend) creates a persona via REST API, then chats with it through the OpenAI-compatible `/v1/chat/completions` endpoint. The twin responds in character, with conversation memory persisted across requests.

**Why this priority**: This is the absolute MVP slice — without it, nothing else matters. Validates core conversation loop, persona storage, memory persistence, LLM routing through OmniRoute.

**Independent Test**: `POST /v1/personas` with `{name, slug, system_prompt}` → `POST /v1/chat/completions` with `{model: "<slug>", messages: [...]}` → verify response uses the persona's system prompt and recalls prior turns within same `conversation_id`.

**Acceptance Scenarios**:

1. **Given** a fresh twin-engine instance with empty DB, **When** `POST /v1/personas` is called with valid payload + `X-Tenant-ID: t1`, **Then** persona is created in Postgres, scoped to tenant `t1`, and a 201 response with persona ID is returned.
2. **Given** a persona exists, **When** `POST /v1/chat/completions` is called with `{model: persona_slug, messages: [{role: user, content: "Привет"}]}` + tenant header, **Then** the response uses the persona's `system_prompt`, routes via OmniRoute to a real LLM, and returns OpenAI-compatible response shape.
3. **Given** a chat is in progress with `conversation_id: c1`, **When** a follow-up message references prior context, **Then** the LLM receives the prior messages from Letta memory and the persona responds with continuity.
4. **Given** tenant `t1` has persona `assistant-a`, **When** tenant `t2` tries to access `assistant-a` via the API, **Then** 404 is returned (no leakage, no "exists but forbidden").

---

### User Story 2 — Train a twin from a real Telegram chat export (Priority: P1)

A user exports their Telegram chat history (JSON), uploads it to twin-engine via API, and the training pipeline extracts speech style (sentence length, emoji usage, lexicon, common phrases) and writes them into the persona's `traits` field. Subsequent chats with the persona reflect the learned style.

**Why this priority**: This is the headline USP — "create a twin that talks like you". Without it, twin-engine is just a fancy prompt store.

**Independent Test**: Upload a real Telegram JSON export → poll training job status → verify persona `traits` JSON contains extracted fields (avg_sentence_length, emoji_density, top_phrases, formality_score, etc.) → chat with persona → observe stylistic mimicry.

**Acceptance Scenarios**:

1. **Given** a persona exists, **When** `POST /v1/personas/{id}/train` is called with a Telegram JSON export (10MB), **Then** a training job is created with status `pending`, returned ID is queryable via `GET /v1/training-jobs/{id}`.
2. **Given** a training job completes, **When** persona is retrieved via `GET /v1/personas/{id}`, **Then** the `traits` field contains extracted stylistic markers (≥5 keys).
3. **Given** WhatsApp TXT export upload, **When** training runs, **Then** the same trait fields are populated (parser-agnostic output schema).
4. **Given** training file >100MB, **When** uploaded, **Then** parsing is streamed (no OOM); progress reported via job status updates.
5. **Given** a corrupt or non-conforming file, **When** uploaded, **Then** training job status transitions to `failed` with a human-readable error message.

---

### User Story 3 — Multi-tenant isolation enforced at every layer (Priority: P1)

A SaaS shell (Dvoiniki) running 100 tenants on a single twin-engine instance — each tenant's personas, conversations, memory, and RAG vectors are isolated. Cross-tenant data leakage is impossible by construction.

**Why this priority**: Without isolation guarantees, twin-engine cannot back any multi-tenant SaaS. This is a hard requirement, not nice-to-have.

**Independent Test**: Create personas for tenants t1 and t2 with same slug → query as t1 → only t1's persona returned → swap header to t2 → only t2's data returned. Inspect Qdrant — collections are namespaced. Inspect Letta — memory namespaces don't cross.

**Acceptance Scenarios**:

1. **Given** tenants t1 and t2 with personas having identical slugs, **When** each tenant queries `GET /v1/personas/<slug>`, **Then** each receives only their own persona.
2. **Given** persona-a@t1 has 1000 RAG documents in Qdrant, **When** persona-a@t2 queries RAG, **Then** 0 results from t1's documents (Qdrant collection `tenant_t1_persona_a` ≠ `tenant_t2_persona_a`).
3. **Given** persona-a@t1 has Letta memory with private user data, **When** the same persona slug is created in t2 and memory is queried, **Then** no t1 memories surface.
4. **Given** a request arrives without `X-Tenant-ID` header (and no JWT tenant claim), **When** any endpoint is hit, **Then** 401 Unauthorized.

---

### User Story 4 — Telegram channel adapter — end-to-end live messaging (Priority: P2)

A tenant configures a Telegram bot token via the channel API. The Telegram adapter (running as a separate process or worker) connects to Telegram, receives messages from real users, routes them to the correct persona via twin-engine core, and sends the reply back to the user — all under 5 seconds end-to-end.

**Why this priority**: Telegram is the highest-priority channel for Dvoiniki's Russian-speaking market. Without it, twin-engine is API-only and not usable as a deployed product.

**Independent Test**: Configure a real Telegram test bot via `POST /v1/channels` → start adapter → send message to bot from a real Telegram client → verify reply arrives within 5 seconds and reflects persona character.

**Acceptance Scenarios**:

1. **Given** a tenant has persona `support-bot`, **When** `POST /v1/channels` with `{type: telegram, persona_id, config: {bot_token}}`, **Then** ChannelInstance is created and a Telegram adapter worker is registered.
2. **Given** adapter is running, **When** a real user sends `/start` to the bot, **Then** the adapter pushes an `incoming_message` event to Redis pub/sub channel `twin.message.in.<channel_id>`.
3. **Given** core consumes the inbound event, **When** persona is invoked via OmniRoute, **Then** the response is published to `twin.message.out.<channel_id>`.
4. **Given** adapter receives the outbound event, **When** sent to Telegram, **Then** the user receives the message in the same chat within 5 seconds.
5. **Given** adapter loses Telegram connection (network blip), **When** reconnection succeeds, **Then** message processing resumes; messages received during outage are recovered from Telegram's update offset.

---

### User Story 5 — WhatsApp channel adapter via Evolution API (Priority: P2)

Same end-to-end flow as Telegram, but for WhatsApp using Evolution API as the underlying connector (instead of native Telegraf).

**Why this priority**: WhatsApp is the second-priority channel for Dvoiniki's market. Pattern proves the adapter framework is generic, not Telegram-specific.

**Independent Test**: Spin up Evolution API instance, configure WhatsApp number via `POST /v1/channels` → verify QR scan flow → send WhatsApp message → receive response.

**Acceptance Scenarios**:

1. **Given** Evolution API is reachable, **When** channel is created with `{type: whatsapp_evolution, persona_id, config: {evolution_url, instance_id}}`, **Then** ChannelInstance is registered and adapter subscribes to Evolution webhook for that instance.
2. **Given** adapter is active, **When** a WhatsApp user messages the connected number, **Then** the same pub/sub flow as Telegram delivers a response within 5 seconds.
3. **Given** Evolution API returns 5xx, **When** sending outbound message, **Then** message is retried with exponential backoff (max 5 attempts, max 5 min).

---

### User Story 6 — OpenAI-compatible drop-in for any LLM client (Priority: P2)

A developer points an existing OpenAI client library (openai-python, openai-node, LangChain, etc.) at twin-engine's base URL using a persona slug as the `model` parameter, and gets identical request/response semantics as the real OpenAI API.

**Why this priority**: Massive distribution unlock — any tool that talks OpenAI talks to twin-engine. Lets SaaS shell devs and OSS users adopt without learning a new SDK.

**Independent Test**: `openai.OpenAI(base_url="http://twin-engine:8090/v1", api_key="<tenant_token>").chat.completions.create(model="my-persona", messages=[...])` — verify it works end-to-end.

**Acceptance Scenarios**:

1. **Given** twin-engine is running, **When** standard openai-python client calls `/v1/chat/completions` with `model=<persona_slug>`, **Then** request shape, response shape, error codes, and streaming semantics all match OpenAI API spec.
2. **Given** `stream: true` in request, **When** completion runs, **Then** SSE chunks arrive in OpenAI-compatible format (`data: {...}\n\n` + `data: [DONE]\n\n`).
3. **Given** persona slug does not exist, **When** chat call is made, **Then** 404 with OpenAI-shaped error body `{error: {message, type: invalid_request_error, code: model_not_found}}`.

---

### User Story 7 — CLI `twin` for devops and one-off operations (Priority: P3)

Operators use `twin` CLI for everything Dvoiniki UI doesn't expose: bulk persona import, training reruns, channel restarts, debugging memory state, dumping conversation history.

**Why this priority**: Lowers barrier for OSS adopters who don't run Dvoiniki SaaS; provides emergency tooling for ops.

**Acceptance Scenarios**:

1. **Given** twin-engine running, **When** `twin persona list --tenant t1`, **Then** all personas for t1 are printed in a table.
2. **Given** a YAML file with persona definitions, **When** `twin persona import personas.yaml --tenant t1`, **Then** all personas are upserted via API.
3. **Given** training file path, **When** `twin train --persona-id p1 --file telegram_export.json`, **Then** training job kicks off and CLI polls until completion.
4. **Given** channel is stuck, **When** `twin channel restart <channel_id>`, **Then** adapter process restarts cleanly.

---

### Edge Cases

- **No tenant context**: Any endpoint hit without `X-Tenant-ID` header AND without a JWT containing tenant claim → 401 Unauthorized. No fallback to "default" tenant ever.
- **Persona context exceeds LLM window**: System prompt + persona traits + memory + last N messages > context_window → context compressor (delegated to Hermes compressor or built-in) drops oldest middle-turns first, keeps system + recent.
- **Training file >100 MB**: Stream-parse, never load full file in memory. Progress reported in 10% increments via job status.
- **Two simultaneous conversations on same persona**: Per-conversation memory is isolated (Letta archival memory per conversation_id), persona-level traits are shared and read-only at chat time.
- **LLM provider down**: OmniRoute circuit breaker activates. Twin-engine surfaces 503 with `Retry-After` header. SSE stream emits an error event and closes cleanly.
- **Channel adapter loses connection >5 min**: Status transitions to `degraded`; fallback to webhook-only mode if applicable; alert emitted to Redis pub/sub `twin.channel.health` for SaaS shell to display.
- **Tenant deleted mid-conversation**: All in-flight requests for that tenant are cancelled, channel adapters for that tenant gracefully disconnect, data is soft-deleted (configurable retention before hard delete for GDPR).
- **Conflicting persona slugs within tenant**: 409 Conflict on create. Slugs are unique per tenant.
- **OpenAI client sends unknown params**: Forwarded silently or rejected, depending on `strict_openai_compat` config flag.
- **Channel webhook delivers duplicate message**: Idempotency via `(channel_id, channel_message_id)` tuple — dupes silently dropped.

## Requirements *(mandatory)*

### Functional Requirements

#### Core Conversation API

- **FR-001**: System MUST expose REST endpoints for Persona CRUD: `POST /v1/personas`, `GET /v1/personas`, `GET /v1/personas/{id}`, `PATCH /v1/personas/{id}`, `DELETE /v1/personas/{id}`. All scoped by tenant.
- **FR-002**: System MUST expose `POST /v1/chat/completions` as **OpenAI-compatible** endpoint. Request and response shapes MUST match OpenAI Chat Completions spec verbatim, with `model` field accepting persona slug.
- **FR-003**: System MUST support `stream: true` mode using Server-Sent Events (SSE) with OpenAI-compatible chunk format and `[DONE]` terminator.
- **FR-004**: System MUST expose REST endpoints for Conversation history: `GET /v1/conversations`, `GET /v1/conversations/{id}/messages`. Tenant-scoped.
- **FR-005**: System MUST accept tenant context via either `X-Tenant-ID` header OR `tenant` JWT claim. Missing tenant context → 401.

#### Persona & Storage

- **FR-006**: Persona entity MUST be stored in Postgres with fields: `id`, `tenant_id`, `name`, `slug`, `system_prompt`, `traits` (JSONB), `model_preferences` (JSONB), `rag_collection_name`, `created_at`, `updated_at`. Unique constraint on `(tenant_id, slug)`.
- **FR-007**: System MUST auto-create per-persona Qdrant collection on first use, named `tenant_{tenant_id}_persona_{persona_id}`, using `@undrestrator/infra-client` SDK.
- **FR-008**: System MUST integrate with Letta as memory layer. Each `conversation_id` gets a Letta agent instance; agent's archival memory is namespaced by `tenant_id/persona_id/conversation_id`.

#### Twin Training Pipeline

- **FR-009**: System MUST accept `POST /v1/personas/{id}/train` with multipart upload of: Telegram JSON export, WhatsApp TXT export, or generic JSONL (`{role, content, timestamp}` per line). Tenant-scoped.
- **FR-010**: Training pipeline MUST extract stylistic traits: `avg_sentence_length`, `sentence_length_distribution`, `emoji_density`, `emoji_top_used`, `top_phrases` (n-gram), `formality_score` (heuristic), `response_latency_pattern` (if timestamps available), `lexicon_size`.
- **FR-011**: Extracted traits MUST be merged into Persona's `traits` JSONB (preserving manual overrides via `traits.manual_lock: [keys]`).
- **FR-012**: Training MUST run as background job via BullMQ (from `@undrestrator/infra-client`). Job status queryable via `GET /v1/training-jobs/{id}` with states: `pending`, `running`, `completed`, `failed`.
- **FR-013**: Training MUST stream-parse files >50 MB to avoid OOM. Progress reported in job status (`progress_percent`).
- **FR-014**: Training pipeline MUST emit a sample-conversation dataset (last 50 representative exchanges) for downstream eval/fine-tuning steps (out of scope for v1, but data is ready).

#### Channel Adapters

- **FR-015**: System MUST define a `ChannelAdapter` TypeScript interface: `connect()`, `disconnect()`, `onIncoming((msg) => void)`, `send(msg)`, `health()`.
- **FR-016**: System MUST ship `@undrecreaitwins/channel-telegram` package (Telegraf-based) implementing `ChannelAdapter`. Connects via long-polling or webhook (configurable).
- **FR-017**: System MUST ship `@undrecreaitwins/channel-whatsapp` package (Evolution API client) implementing `ChannelAdapter`. Connects via Evolution webhook + REST send.
- **FR-018**: Channel adapters MUST publish inbound messages to Redis pub/sub topic `twin.message.in.{channel_id}`. Core orchestrator consumes, invokes LLM via OmniRoute, publishes reply to `twin.message.out.{channel_id}`. Adapter sends to channel.
- **FR-019**: System MUST expose `POST /v1/channels`, `GET /v1/channels`, `DELETE /v1/channels/{id}` for ChannelInstance CRUD. Tenant-scoped.
- **FR-020**: Adapter processes MUST be supervised — restart on crash, exponential backoff on reconnect failures (max 5 min interval).
- **FR-021**: Each ChannelInstance MUST have unique idempotency key on `(channel_type, external_channel_message_id)` — duplicate inbound messages within 5 min window are silently dropped.

#### Multi-Tenant Primitives

- **FR-022**: All DB queries MUST be filtered by `tenant_id` from request context. Enforced via repository layer — no raw SQL bypassing tenant filter.
- **FR-023**: Qdrant collections MUST follow naming convention `tenant_{id}_persona_{id}` — cross-tenant access fails at Qdrant layer (not just app layer).
- **FR-024**: Letta memory namespaces MUST include `tenant_id` prefix.
- **FR-025**: System MUST provide an integration test suite that creates 2 tenants with overlapping data and asserts zero leakage across all endpoints.

#### CLI (`twin`)

- **FR-026**: `twin` CLI MUST provide subcommands: `persona [list|create|get|update|delete|import]`, `conversation [list|get|export]`, `train [start|status|cancel]`, `channel [list|create|start|stop|restart|delete]`, `health`, `version`.
- **FR-027**: CLI MUST read tenant context from `--tenant` flag or `TWIN_TENANT_ID` env var.
- **FR-028**: CLI MUST connect to twin-engine API via `--base-url` flag or `TWIN_API_URL` env var (default `http://localhost:8090`).

#### Integration with Orchestra

- **FR-029**: Twin-engine MUST use `@undrestrator/infra-client` SDK for LLM (OmniRoute), Vector (Qdrant), Queue (BullMQ/Redis) clients — no duplicate client implementations.
- **FR-030**: Twin-engine MAY delegate complex reasoning to Hermes Agent (from orchestra) via Hermes API. Per-conversation Hermes session lifecycle is managed by twin-engine.
- **FR-031**: Twin-engine MUST emit usage events (tokens consumed, model, tenant_id, persona_id, conversation_id) to OmniRoute's existing usage stream OR to a configurable OpenMeter endpoint — for billing in SaaS shell.

#### Deployment & Licensing

- **FR-032**: Repository MUST be licensed under **Apache 2.0** (permissive, allows closed-source consumers like Dvoiniki SaaS).
- **FR-033**: System MUST ship `docker-compose.standalone.yml` (twin-engine + Postgres + Redis only — minimal dev setup) AND `docker-compose.with-orchestra.yml` (depends_on: orchestra services from undrestrator).
- **FR-034**: System MUST provide `.env.example` with all required and optional configuration variables documented.
- **FR-035**: Public API MUST follow semantic versioning. Breaking API changes only in major version bumps. Migration guides in `CHANGELOG.md`.

### Key Entities

- **Tenant**: External primitive (twin-engine does not own tenant lifecycle — that's Dvoiniki SaaS or external). Stored as opaque `tenant_id` (UUID or string) propagated via request context. Twin-engine validates existence only via presence in `tenants` reference table (populated by SaaS shell or manually for OSS users).
- **Persona**: Digital twin definition. Fields: `id`, `tenant_id`, `name`, `slug` (URL-safe, unique per tenant), `system_prompt`, `traits` (JSONB — extracted + manual), `model_preferences` (JSONB — preferred LLM provider/model, fallbacks, temperature), `rag_collection_name`, timestamps.
- **Conversation**: A discrete chat session with a persona. Fields: `id`, `tenant_id`, `persona_id`, `channel_id` (nullable for API-only chats), `external_user_id` (channel user ID or API caller), `summary`, `started_at`, `ended_at`, `message_count`.
- **Message**: A single turn in a conversation. Fields: `id`, `conversation_id`, `role` (`user`|`assistant`|`system`|`tool`), `content`, `metadata` (JSONB — provider, model, token counts, latency_ms), `created_at`.
- **ChannelInstance**: A configured external channel for a persona. Fields: `id`, `tenant_id`, `persona_id`, `channel_type` (`telegram`|`whatsapp_evolution`|...), `config` (JSONB — bot tokens, instance IDs, webhooks), `status` (`active`|`degraded`|`disconnected`|`error`), `last_health_check_at`.
- **TrainingJob**: An async persona-training task. Fields: `id`, `tenant_id`, `persona_id`, `source_type` (`telegram_json`|`whatsapp_txt`|`generic_jsonl`), `source_file_ref`, `status`, `progress_percent`, `extracted_traits` (JSONB), `error_message`, `started_at`, `completed_at`.
- **UsageEvent**: A billable event (token consumption). Fields: `id`, `tenant_id`, `persona_id`, `conversation_id`, `provider`, `model`, `input_tokens`, `output_tokens`, `latency_ms`, `created_at`. Emitted to OpenMeter or local Postgres for SaaS shell to aggregate.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: First persona created and chatted with via OpenAI-compatible API within 3 minutes of `docker compose -f docker-compose.standalone.yml up -d` (excluding LLM provider config time).
- **SC-002**: Single twin-engine instance handles ≥100 concurrent persona conversations (each ≤500 tokens/turn) on a 4 vCPU / 8 GB RAM box without p95 latency degradation >20% vs single-conversation baseline.
- **SC-003**: Telegram channel end-to-end latency (user message → user receives reply): p95 < 5 seconds (excluding LLM provider time >2s).
- **SC-004**: Twin training from a 10 MB Telegram JSON export completes in < 60 seconds on a 4 vCPU box.
- **SC-005**: Multi-tenant isolation integration test (`isolation.test.ts`) passes — 0 cross-tenant leakage detected across all endpoints.
- **SC-006**: OpenAI-compatible endpoint passes a compatibility test using stock `openai-python` and `openai-node` SDKs against ≥5 common request patterns (single-shot, streaming, system+user, multi-turn, tool-use stub).
- **SC-007**: API documentation (OpenAPI 3.1 spec) is generated and covers 100% of public endpoints.
- **SC-008**: `twin` CLI installs via `npm i -g @undrecreaitwins/cli` and `twin --version` works on Linux/macOS/Windows.

---

## Dependencies & Assumptions

- **Hard dependency**: undrestrator orchestra v0.x running and reachable (OmniRoute, Qdrant, Redis at minimum). `docker-compose.with-orchestra.yml` includes orchestra as `depends_on`.
- **Hard dependency**: `@undrestrator/infra-client` SDK (uses for LLM/Vector/Queue clients).
- **Optional dependency**: Hermes Agent from orchestra (for delegated reasoning and Honcho user-modeling).
- **Optional dependency**: Letta (self-hosted) for agent memory. If absent, falls back to in-context window-only memory (degraded mode flagged in `/health`).
- **External dependency**: Postgres ≥15 (for JSONB, ULID extensions). Bundled in `standalone.yml`.
- **External dependency for WhatsApp channel**: Evolution API instance (separate deployment, not bundled).
- **Assumption**: SaaS consumer (Dvoiniki) owns auth/authz at API gateway layer (e.g., Traefik + Keycloak). Twin-engine trusts `X-Tenant-ID` header and does NOT verify JWT signatures itself (delegated). For standalone OSS use, simple API token auth suffices.
- **Assumption**: n8n (from orchestra) is NOT used as a channel adapter — it's reserved for async integrations in the SaaS layer (CRM sync, scheduled tasks).

## Out of Scope (Reiterated)

- UI of any kind (admin, tenant dashboard, chat widget) — Dvoiniki SaaS shell territory.
- Multi-tenant authentication, billing, plan management — Dvoiniki SaaS shell.
- Voice and avatar channels — v2.
- Email inbound, Discord, Slack, Signal channels — Hermes from orchestra already covers these for SaaS shell consumers. Not duplicated here.
- Fine-tuning of LLM weights — twin-engine uses prompt-based mimicry only.
- CRM-specific adapters (AmoCRM, HubSpot, etc.) — SaaS shell territory (via n8n templates).
- Hosted SaaS offering of twin-engine itself — this is a backend library/service, not a product.
