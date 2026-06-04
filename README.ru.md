# undrecreaitwins

Open-source **headless, мультиарендный backend ИИ-двойников (цифровых клонов)**. Персоны общаются по OpenAI-совместимому API, заземляют ответы на загруженных документах (RAG), достают пользователей по каналам и улучшаются через цикл «человек поправил → few-shot».

## Стек

TypeScript · Fastify · PostgreSQL + **pgvector** · Redis (BullMQ + Streams) · Drizzle · **Honcho** (память агента) · **hermes-agent** (агентный executor, спека 010) · **BGE-M3 + reranker через TEI** · Langfuse (observability). Полный список: [`specs/main/requirements.md`](specs/main/requirements.md). Топология: [`specs/main/architecture.md`](specs/main/architecture.md).

## Быстрый старт (Docker)

```bash
# 1) Задать env в infra/.env — минимум:
#    DATABASE_URL, REDIS_URL, LLM_PROVIDER_URL, LLM_API_KEY, EMBEDDINGS_URL
#    (агентный, спека 010) HERMES_ACP_CMD, ENGINE_MCP_SECRET, ENGINE_MCP_PORT, HONCHO_URL
# 2) Поднять самодостаточный стек:
docker compose -f infra/docker-compose.standalone.yml up -d
# Health API → http://localhost:8090/v1/health
```

- **`infra/docker-compose.standalone.yml`** — движок + Postgres(**pgvector**) + Redis + TEI-сайдкар эмбеддингов + **`hermes-agent` + Honcho** (агентный executor, спека 010) (всё своё).
- **`infra/docker-compose.with-orchestra.yml`** — движок + воркеры; Postgres/Redis/LLM-gateway берутся из общего стека *orchestra* (не бандлятся).
- **Langfuse** — отдельным compose (тяжёлый: +ClickHouse); движок только ссылается через `LANGFUSE_*`.

## Разработка

```bash
npm install
npm run dev        # API на :8090
npm test           # Vitest (unit + integration)
```

## Фоновые воркеры

- **Document Worker** (`packages/training`): parse → chunk → embed → pgvector (BullMQ).
- **Re-engagement Worker** (спека 009): сканирует уснувшие диалоги, шлёт win-back хуки.
  - `npm run worker:reengagement` — задать `TWIN_REENGAGE_WORKERS`, `REDIS_URL`.

## Агентный Executor (спека 010)

Персоны с `agentEnabled` работают как **Hermes-агенты** (self-host `hermes-agent`, MIT), а не простые completions: циклы plan→tool→observe с реальными **write-действиями** (CRM/календарь/запись) через **engine-mediated tool-gateway** — per-persona allow-list, право-на-запись на тенанта, идемпотентность `reserve→execute→finalize` и полный аудит (`action_audit`). Рабочая память — в **Honcho** (восстановима из Postgres SoR). Каждый ответ проходит outbound-гейт **валидаторов (004)**; при недоступности Hermes или жёстком таймауте `maxExecutionMs` ход деградирует в тонкий completion (fail-open). Каждый ход пишется в `agent_runs` и метрится в OpenMeter.

## Каналы

Standalone-адаптеры (каждый — `ChannelAdapter`-воркер поверх Redis-Streams-транспорта):
**Telegram Bot API** · **WhatsApp** (Evolution API) · **Telegram MTProto userbot** (GramJS, спека 006).

## Ключевые переменные окружения

| Var | Назначение |
|-----|------------|
| `DATABASE_URL` | PostgreSQL (с pgvector) |
| `REDIS_URL` | BullMQ + транспорт каналов |
| `LLM_PROVIDER_URL` / `LLM_API_KEY` | OpenAI-совместимый LLM-gateway |
| `EMBEDDINGS_URL` | TEI-сайдкар (BGE-M3 + BGE-reranker-v2-m3) |
| `LANGFUSE_*` | observability / eval (опционально) |
| `TWIN_STREAM_TIMEOUT_MS` | streaming completions (спека 002) |
| `TWIN_REENGAGE_*` | re-engagement воркеры (спека 009) |
| `HERMES_ACP_CMD` | команда, которую движок спавнит для ACP-хода (спека 010), напр. `hermes acp --accept-hooks` |
| `ENGINE_MCP_SECRET` / `ENGINE_MCP_PORT` | engine-MCP-сервер (tool-gateway): secret + порт (спека 010) |
| `HONCHO_URL` | сервис рабочей памяти агента (спека 010) |
| `AGENT_MAX_EXECUTION_MS` / `AGENT_LOOP_CAP` | жёсткий таймаут агента + loop/cost-cap (спека 010) |

## Документация

- **Архитектура**: [`specs/main/architecture.md`](specs/main/architecture.md)
- **Требования**: [`specs/main/requirements.md`](specs/main/requirements.md)
- **Спеки фич**: `specs/<NNN-feature>/` (spec.md · plan.md · tasks.md)

> Мультиарендность by design: каждый запрос scoped по тенанту через Postgres RLS (`app.current_tenant`). Движок — server-to-server (Bearer); admin-UI владеет Product-слой (`ai-twins`).
