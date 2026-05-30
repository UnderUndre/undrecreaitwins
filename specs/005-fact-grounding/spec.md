# Спецификация 005: Fact Grounding (RAG Runtime)

## 1. Описание

Реализация RAG-модуля (Retrieval-Augmented Generation) на уровне Engine (`undrecreaitwins`) для поддержки фактической точности LLM. Обеспечивает интеграцию с векторной базой данных и парсинг сложных документов.

## 2. Архитектура и Технологии

> **ВЫРОВНЕНО на субстрат 008-agent-builder (2026-05-30, по решению пользователя).** Ранее предполагался Qdrant с пометкой «уже присутствует в стеке» — но recon (`agent_builder_recon.md` §2) подтвердил: **Qdrant в движке НЕТ**, как и pgvector. Чтобы не плодить два RAG-стека в одном движке, 005 и 008 делят **ОДИН** субстрат. ⚠️ Сессия/ИИ, ведущая 005, должна подхватить это изменение (ранее планировался клиент Qdrant — отменяется).

- **Векторное хранилище:** **pgvector** на существующем Postgres (общий с 008; см. `008-agent-builder/data-model.md`). Без отдельного сервиса.
- **Эмбеддинги:** общий **embedding-service** — BGE-M3 + BGE-reranker-v2-m3 (мультиязычный, вкл. русский), тот же, что строит 008 (T006). Не дублировать.
- **Парсинг документов:** TS-native (**officeParser**) для PDF/DOCX/TXT, общий с 008. PaddleOCR / RAGFlow — опциональный Python-сайдкар ТОЛЬКО если появятся тяжёлые сканы / сложные таблицы (отложено).

## 3. Интерфейсы

```typescript
interface IGroundingEngine {
  query(query: string, twinId: string): Promise<GroundingContext[]>;
  ingest(document: Buffer, meta: DocumentMeta): Promise<void>;
}
```

## 4. Задачи

1. ~~Развернуть Qdrant клиент~~ → Использовать общий **pgvector**-стор + Drizzle vector-тип из 008 (инфраструктуру не дублировать).
2. ~~Настроить пайплайн эмбеддингов~~ → Использовать общий **embedding-service** (BGE-M3) из 008 (T006).
3. (Опционально, отложено) PaddleOCR / RAGFlow сайдкар — только под тяжёлый парсинг сканов/таблиц.
4. Написать механизм гибридного поиска (Full-text + Vector) поверх pgvector.
5. Реализовать `IGroundingEngine` (query/ingest) поверх общего субстрата.
