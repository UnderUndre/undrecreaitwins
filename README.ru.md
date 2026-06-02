# undrecreaitwins

Open-source **headless, мультиарендный backend ИИ-двойников (цифровых клонов)**. Персоны общаются по OpenAI-совместимому API, заземляют ответы на загруженных документах (RAG), достают пользователей по каналам и улучшаются через цикл «человек поправил → few-shot».

## Стек

TypeScript · Fastify · PostgreSQL + **pgvector** · Redis (BullMQ + Streams) · Drizzle · Letta (память) · **BGE-M3 + reranker через TEI** · Langfuse (observability). Полный список: [`specs/main/requirements.md`](specs/main/requirements.md). Топология: [`specs/main/architecture.md`](specs/main/architecture.md).

## Быстрый старт (Docker)

```bash
# 1) Задать env в infra/.env — минимум:
#    DATABASE_URL, REDIS_URL, LLM_PROVIDER_URL, LLM_API_KEY, EMBEDDINGS_URL
# 2) Поднять самодостаточный стек:
docker compose -f infra/docker-compose.standalone.yml up -d
# Health API → http://localhost:8090/v1/health
```

- **`infra/docker-compose.standalone.yml`** — движок + Postgres(**pgvector**) + Redis + TEI-сайдкар эмбеддингов (всё своё).
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

## Документация

- **Архитектура**: [`specs/main/architecture.md`](specs/main/architecture.md)
- **Требования**: [`specs/main/requirements.md`](specs/main/requirements.md)
- **Спеки фич**: `specs/<NNN-feature>/` (spec.md · plan.md · tasks.md)

> Мультиарендность by design: каждый запрос scoped по тенанту через Postgres RLS (`app.current_tenant`). Движок — server-to-server (Bearer); admin-UI владеет Product-слой (`ai-twins`).
