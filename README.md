# undrecreaitwins

Open-source **headless, multi-tenant AI-twin (digital clone) backend**. Personas chat over an OpenAI-compatible API, ground answers in uploaded docs (RAG), reach users across channels, and improve via a human-correction feedback loop.

## Stack

TypeScript · Fastify · PostgreSQL + **pgvector** · Redis (BullMQ + Streams) · Drizzle · **Honcho** (agent memory) · **hermes-agent** (agentic executor, spec 010) · **per-assistant BYOK LLM providers** (custom OpenAI-compatible, spec 011) · **BGE-M3 + reranker via TEI** · Langfuse (observability). Full list: [`specs/main/requirements.md`](specs/main/requirements.md). Topography: [`specs/main/architecture.md`](specs/main/architecture.md).

## Quick Start (Docker)

```bash
# 1) Set env in infra/.env — at minimum:
#    DATABASE_URL, REDIS_URL, LLM_PROVIDER_URL, LLM_API_KEY, EMBEDDINGS_URL
#    (agentic, spec 010/013) HERMES_ACP_CMD, ENGINE_MCP_SECRET, ENGINE_MCP_PORT, HONCHO_URL, AGENTIC_EXECUTOR_ENABLED
# 2) Bring up the self-contained stack:
docker compose -f infra/docker-compose.standalone.yml up -d
# API health → http://localhost:8090/v1/health
```

- **`infra/docker-compose.standalone.yml`** — engine + Postgres(**pgvector**) + Redis + TEI embedding sidecar + **`hermes-agent` + Honcho** (agentic executor, spec 010) (self-contained).
- **`infra/docker-compose.with-orchestra.yml`** — engine + workers; Postgres/Redis/LLM-gateway come from the shared *orchestra* stack (not bundled).
- **Langfuse** runs as its own compose (heavy: +ClickHouse); the engine only references it via `LANGFUSE_*`.

## Local Hermes (without Docker)

The engine calls Hermes by **spawning it as a subprocess over stdio (ACP)** — it is *not* a network service, so there is nothing to "connect to". To run Hermes natively instead of from the bundled `hermes-agent` container, point `HERMES_ACP_CMD` at a locally-installed binary:

```bash
# 1) Install hermes-agent locally with ACP support, verify:
pipx install 'hermes-agent[acp]==0.15.1'
hermes acp --check                     # checks ACP deps + adapter imports, then exits

# 2) Point the engine at the local binary. On Windows use an ABSOLUTE path — the engine
#    spawns WITHOUT a shell, so a bare `hermes` won't resolve:
#   infra/.env
HERMES_ACP_CMD=C:\Users\<you>\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe acp --accept-hooks
#   macOS/Linux:  HERMES_ACP_CMD=hermes acp --accept-hooks

# 3) Run the engine native; keep only the stateful deps in Docker (or use local ones):
docker compose -f infra/docker-compose.standalone.yml up -d postgres redis honcho  # deps only
pnpm db:migrate                        # from repo ROOT (drizzle.config.ts lives there)
cd packages/api && pnpm dev            # engine on :8090, spawns local `hermes acp` per pool slot
```

- The engine-hosted **MCP tool-gateway** binds `localhost:$ENGINE_MCP_PORT`; native Hermes reaches it directly (no `host.docker.internal`).
- **Honcho** unavailable → working memory degrades to cold (the turn still proceeds) — fine for local dev.
- Verify: a turn for an `agentEnabled` persona spawns `hermes acp` (see engine logs) and streams `session/update` events.

## Development

```bash
npm install
npm run dev        # API on :8090
npm test           # Vitest (unit + integration)
```

## Background Workers

- **Document Worker** (`packages/training`): parse → chunk → embed → pgvector (BullMQ).
- **Re-engagement Worker** (spec 009): scans dormant conversations, sends AI-generated win-back hooks.
  - `npm run worker:reengagement` — set `TWIN_REENGAGE_WORKERS`, `REDIS_URL`.

## Agentic Executor (spec 010)

Personas with `agentEnabled` run as **Hermes agents** (self-hosted `hermes-agent`, MIT) instead of plain completions: plan→tool→observe loops with real **write-actions** (CRM/calendar/booking) through an **engine-mediated tool-gateway** — per-persona allow-list, per-tenant write-permission, `reserve→execute→finalize` idempotency, and full audit (`action_audit`). Working memory lives in **Honcho** (reconstructible from the Postgres SoR). Every answer passes the **validators (004)** outbound gate; on Hermes outage or a hard `maxExecutionMs` timeout the turn degrades to a thin completion (fail-open). Each turn is recorded in `agent_runs` and metered to OpenMeter.

## Per-assistant LLM provider — BYOK (spec 011)

Each assistant — and a tenant-level default — can run on its **own custom OpenAI-compatible provider**: base URL + API key + model id (+ temperature / max-tokens). Config resolves `assistant → tenant → platform default`; the API key is **encrypted at rest** and never logged. It reaches Hermes per spawn via a **throwaway profile**: the engine writes a temp `config.yaml` (`model.{provider: custom, base_url, default, temperature, max_tokens}`), points `HERMES_HOME` at it, and passes the key via `OPENAI_API_KEY` (env only, never on disk) — verified against `hermes-agent` v0.15.1. The user-supplied base URL is **SSRF-guarded** (DNS-resolve-and-pin via an undici dispatcher). The admin UI lives in the Product layer (`ai-twins`).

> *Durable-retry on provider outage (US2 "no message loss") is scaffolded but **deferred** — see [`specs/011-llm-configuration/followup-Y-durable-retry.md`](specs/011-llm-configuration/followup-Y-durable-retry.md).*

## Channels

Standalone adapters (each a `ChannelAdapter` worker over the Redis Streams transport):
**Telegram Bot API** · **WhatsApp** (Evolution API) · **Telegram MTProto userbot** (GramJS, spec 006).

## Key Environment Variables

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL (with pgvector) |
| `REDIS_URL` | BullMQ + channel transport |
| `LLM_PROVIDER_URL` / `LLM_API_KEY` | OpenAI-compatible LLM gateway |
| `EMBEDDINGS_URL` | TEI sidecar (BGE-M3 + BGE-reranker-v2-m3) |
| `LANGFUSE_*` | observability / eval (optional) |
| `TWIN_STREAM_TIMEOUT_MS` | streaming completions (spec 002) |
| `TWIN_REENGAGE_*` | re-engagement workers (spec 009) |
| `HERMES_ACP_CMD` | command the engine spawns for the ACP turn (spec 010), e.g. `hermes acp --accept-hooks` |
| `ENGINE_MCP_SECRET` / `ENGINE_MCP_PORT` | engine-hosted MCP server (tool-gateway) auth secret + port (spec 010) |
| `HONCHO_URL` | agent working-memory service (spec 010) |
| `AGENT_MAX_EXECUTION_MS` / `AGENT_LOOP_CAP` | agent hard timeout + loop/cost cap (spec 010) |

## Docs

- **Architecture**: [`specs/main/architecture.md`](specs/main/architecture.md)
- **Requirements**: [`specs/main/requirements.md`](specs/main/requirements.md)
- **Feature specs**: `specs/<NNN-feature>/` (spec.md · plan.md · tasks.md)

> Multi-tenant by design: every request is tenant-scoped via Postgres RLS (`app.current_tenant`). Engine is server-to-server (Bearer); the Product layer (`ai-twins`) owns the admin UIs.
