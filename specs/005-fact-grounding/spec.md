# Спецификация 005: Fact Grounding (RAG Runtime)

## 1. Описание

Реализация RAG-модуля (Retrieval-Augmented Generation) на уровне Engine (`undrecreaitwins`) для поддержки фактической точности LLM. **005 — это retrieval-слой поверх общего субстрата 008**: он НЕ строит собственный ingest-пайплайн и НЕ дублирует парсинг/эмбеддинги, а оркеструет поиск и формирование контекста для LLM.

## 2. Архитектура и Технологии

> **ВЫРОВНЕНО на субстрат 008-agent-builder (2026-05-30, по решению пользователя).** Ранее предполагался Qdrant с пометкой «уже присутствует в стеке» — но recon (`agent_builder_recon.md` §2) подтвердил: **Qdrant в движке НЕТ**, как и pgvector. Чтобы не плодить два RAG-стека в одном движке, 005 и 008 делят **ОДИН** субстрат.

- **Векторное хранилище:** **pgvector** на общем Postgres (таблицы `documents`, `document_chunks` определены в `008-agent-builder/data-model.md`). 005 новых таблиц НЕ вводит.
- **Эмбеддинги + reranking:** общий **embedding-service** (008 T006) — TEI-сайдкар (008 T002) с **BGE-M3** (embed) + **BGE-reranker-v2-m3** (rerank) по HTTP. Мультиязычный, русский — нативно. Не дублировать.
- **Поиск:** **vector (HNSW cosine) + reranker**. Кандидаты по векторному сходству → переранжирование BGE-reranker-v2-m3 → top-N в бюджет контекста (§5).
  - ⚠️ **Full-text / hybrid — ОТЛОЖЕНО** (§11). В субстрате 008 НЕТ tsvector/GIN — гибрид потребовал бы правки **общего** data-model 008. Решение пользователя (2026-05-31): запускаемся на vector+rerank; FTS — отдельным backlog-пунктом, когда keyword-recall окажется недостаточным.
- **Ingest документов:** делегируется **общему document-service 008 (T020)** — async-пайплайн на BullMQ (`officeParser → chunk → embed → store document_chunks`). 005 парсер заново НЕ пишет. PaddleOCR / RAGFlow — опциональный Python-сайдкар ТОЛЬКО под тяжёлые сканы/таблицы (отложено).

## 3. Интерфейс

```typescript
type DocumentStatus = 'pending' | 'parsing' | 'ready' | 'failed';
interface IngestResult { documentId: string; status: DocumentStatus; }

interface IGroundingEngine {
  // tenantId ОБЯЗАТЕЛЕН — открывает RLS через withTenantContext; twinId маппится на personaId.
  // Возвращает [] если ни один чанк не прошёл порог reranker-скора (no-context).
  query(query: string, tenantId: string, twinId: string): Promise<GroundingContext[]>;

  // Async: ставит задачу в document-service 008, НЕ ждёт готовности.
  // Retrieval видит документ только после status === 'ready'.
  ingest(document: Buffer, meta: DocumentMeta, tenantId: string, twinId: string): Promise<IngestResult>;
}
```

(Полный контракт + `DocumentMeta` / `GroundingContext`: `contracts/IGroundingEngine.ts`.)

## 4. Tenancy и доменный ключ (F1, F5)

- **RLS-изоляция:** ВСЕ обращения к БД (retrieval и ingest) идут через `withTenantContext(tenantId, fn)` (`packages/core/src/db.ts`), который ставит `SET LOCAL app.current_tenant`. Политика 008: `USING (tenant_id = current_setting('app.current_tenant')::uuid)`. Без `tenantId` RLS не открыть → `query()` без него физически не работает (риск кросс-тенант утечки/пустых чтений устранён).
- **twinId = personaId (identity, НЕ lookup):** `twinId` в этом интерфейсе — это и есть `personaId` строки 008 (один twin = одна persona/assistant). Lookup-маппинга нет: значение передаётся как `personaId` напрямую. Retrieval фильтрует `document_chunks` по `personaId = twinId` **внутри** tenant-контекста (`personaId` — денормализованная колонка в 008 ровно под этот фильтр).
- **Тест обязателен:** tenant A НЕ должен получать чанки tenant B (tasks.md T006).

## 5. Параметры retrieval (стартовые дефолты, тюнингуются)

- `vectorTopK = 20` — кандидатов из HNSW по cosine.
- `rerankTopN = 5` — после BGE-reranker-v2-m3.
- `contextBudgetTokens ≈ 2000` — суммарный бюджет; чанки добавляются по убыванию rerank-скора до бюджета. Подсчёт токенов — токенайзером BGE-M3; если недоступен на call-site, аппроксимация `chars/4`.
- `minRerankScore = 0.3` — порог отсечения; если лучший кандидат ниже — `query()` возвращает `[]`.
- **Русский:** нативно мультиязычным BGE-M3; отдельный стемминг для vector-пути НЕ нужен (понадобился бы только для отложенного FTS-пути, §11).
- **Латентность (ориентир, не жёсткий SLO итерации):** p95 `query()` ≤ ~800 ms при тёплом embedder (исключая cold-start эмбеддера/reranker). Тюнингуется.

## 6. Жизненный цикл ingest (F3)

- `ingest()` — **асинхронный**, делегирует document-service 008 (BullMQ-воркер T020), возвращает `{ documentId, status }` сразу.
- Статусы (как в 008): `pending → parsing → ready | failed`.
- **Retrieval только по `ready`.** `pending` / `parsing` / `failed` в выдачу не попадают.
- Владение retry / cleanup / частичными эмбеддингами — на стороне 008 document-service (единый владелец пайплайна). 005 не дублирует.

## 7. Лимиты и таксономия ошибок (F6)

Лимиты наследуются из 008 (восстановлены явно): MIME `pdf` / `docx` / `txt` (enum-checked); размер ≤ 10 MB; ≤ 10 документов на persona.

| Ситуация | `ingest()` | `query()` |
|----------|-----------|-----------|
| Unsupported MIME | reject (typed error, до enqueue) | — |
| Too large (>10 MB) | reject (typed error) | — |
| Лимит документов исчерпан | reject (typed error) | — |
| Parse failed | `status: 'failed'` (async) | документ не виден |
| Embedder (BGE-M3) недоступен | `status: 'failed'`, без полузаписи | typed error — без эмбеддинга запроса поиск невозможен (НЕ `[]`, НЕ partial) |
| Reranker (BGE-reranker-v2-m3) недоступен | не используется при ingest | fallback: vector-only порядок по cosine, без reranking |
| Duplicate ingest | идемпотентность на стороне 008 document-service | — |
| DB timeout | typed error, проброс | typed error, проброс |
| Нет релевантного контекста | — | `[]` (не ошибка) |

**Enforcement лимитов:** 005 валидирует MIME / размер / лимит документов ДО enqueue (fail-fast, defense-in-depth). Авторитетная граница — upload-boundary 008; двойная проверка допустима и намеренна.

## 8. Модель консистентности (почему НЕ нужен locking)

> Ответ на gemini F1/F2: в 005 НЕТ мультиагентной мутации фактов и НЕТ внешнего fetch на `query`. Чанки **иммутабельны** после ingest (append-only); конкурентный ingest одного документа разруливается статусами + идемпотентностью document-service 008. Версионирование / локи на «fact-grounding операции» не требуются — такой мутирующей операции в дизайне нет. Конкурентность ingest/retrieval наследует гарантии субстрата 008 (RLS + транзакции).

## 9. Предусловие: барьер субстрата 008 (F2)

005 НЕ может стартовать до готовности общего субстрата. Блокирующие задачи 008:

| 008 Task | Что даёт |
|----------|----------|
| T002 | TEI-сайдкар (BGE-M3 + BGE-reranker-v2-m3) |
| T004 | pgvector extension + Drizzle `vector(1024)` |
| T006 | `embedding-service.ts` (клиент TEI) |
| T007 | модели `documents`, `document_chunks` |
| T008 | RLS-политики + HNSW cosine индексы |

Все пять + чекпоинт 008 «substrate ready» (после T008) ДОЛЖНЫ быть завершены до старта 005 T001/T003. Ingest-адаптер 005 дополнительно зависит от 008 **T020** (document-service + BullMQ).

## 10. Задачи

1. ~~Развернуть Qdrant клиент~~ → использовать общий **pgvector** + Drizzle vector-тип из 008 (не дублировать).
2. ~~Настроить пайплайн эмбеддингов~~ → общий **embedding-service** (008 T006).
3. ~~Реализовать officeParser-парсер~~ → **дубль 008 T020**; ingest 005 делегирует document-service 008, парсер заново НЕ писать.
4. Реализовать **vector + reranker** поиск поверх pgvector (НЕ hybrid; FTS отложен — §11).
5. Реализовать `IGroundingEngine` (query/ingest) с обязательным `withTenantContext` и маппингом `twinId → personaId`.

(Детальный task-граф с зависимостями и тестами: `tasks.md`.)

## 11. Отложено (Deferred)

- **Hybrid full-text + vector.** Требует добавить generated `tsvector` + GIN-индекс + русскую конфигурацию (`russian` text search config) + формулу rank-blend в **общий** `008-agent-builder/data-model.md` + отдельный migration-таск. Подключать, когда vector+rerank даст недостаточный keyword-recall (точные артикулы / имена / коды). Backlog-пункт, вне scope текущей итерации 005.
