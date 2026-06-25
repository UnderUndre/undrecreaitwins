# Feature Specification: 028 — Big Context Window LLM as RAG

**Feature Branch**: `028-big-context-window-llm-as-rag`  
**Created**: 2026-06-24  
**Status**: Draft  
**Input**: User description: "заменить RAG (чанкование + векторы + reranker) на прямую передачу документов в LLM с большим контекстным окном"
**Research**: [`research.md`](./research.md) — document storage patterns, PostgreSQL TOAST performance, extraction library comparison

## Context

**Current architecture** (vector RAG):
```
Documents → text extraction → chunking (512 tokens) → BGE-M3 embedding → pgvector
Query → BGE-M3 embedding → cosine similarity top-K → BGE-reranker-v2-m3 → context → LLM
```

**Problems**:
1. Chunking loses document-level structure (tables, multi-page sections split across chunks)
2. Vector search misses exact matches (prices, phone numbers, SKUs) — semantic similarity ≠ lexical match
3. Embedding pipeline is brittle — empty query → 400 from adapter (production bug, see `doc-extraction-pipeline.ts`)
4. Reranker adds latency (~200ms per request) and another service dependency
5. Complex: 4 moving parts (embedding adapter, pgvector, reranker, retrieval logic)

**Proposed architecture** (big context LLM):
```
Documents → raw text extraction → full text stored as-is (no chunking, no embedding)
Query → concatenate ALL document text (up to context budget) → inject into LLM system/user prompt → LLM answers with full document awareness
```

**Proven by**: Claude read a 46-page PDF (~64KB, ~16K tokens) in one call and could answer any question about it — no chunking needed. Modern LLMs (Claude 200K, GPT-4 Turbo 128K, Gemini 1M) have context windows large enough for typical persona document sets (10-50 pages).

## Clarifications

### Session 2026-06-24

- Q: When documents exceed the context budget under `truncationStrategy: 'silent'`, which documents are kept vs dropped? → A: Explicit per-document `priority` (operator-set, default 0); keep highest-priority first, ties broken by most-recent first — so an operator can pin the price list so it survives truncation.
- Q: What isolation + logging posture applies when full document text is injected into the prompt? → A: Strict scope (same tenant AND persona association as vector RAG — no cross-persona/tenant docs) + redacted logs (injected full text never written to logs/traces; only doc IDs, token counts, truncation decisions).
- Q: When are a big-context persona's vector embeddings built so `fallback-vector` works without a query-time cold-start stall? → A: Eager background job when fallback is opted-in (or budget first exceeded); until the job completes, over-budget queries degrade to `'silent'` truncation — never a synchronous query-time re-index. (Also: the config field is canonically `truncationStrategy: 'fallback-vector'`; the earlier name `groundingFallback` is normalized to it.)
- Q: How are tokens counted against the budget (FR-005)? → A: **RESOLVED** (web research, 2026-06-24) — OmniRoute exposes a pre-call count endpoint `POST /v1/messages/count_tokens` (Anthropic `count_tokens` format, returns `input_tokens`), with an internal tiktoken (BPE) fallback for exact offline counts when an upstream provider has no count endpoint. Engine counts before sending and reserves a ≥5% margin; no raw chars/4 estimate (Cyrillic tokenizes denser). Plan-time (non-blocking): confirm request shape for non-Claude models, exact base path (`/v1` vs `/api/v1`) for `LLM_PROVIDER_URL`, and response field name.
- Q: What cost guardrail does big-context need beyond per-persona opt-in? → A: Per-reply input-token/cost metric via the existing Langfuse trace + surface cost & added latency to the operator in the UI (closes the "visible to operator" edge case). No per-tenant cumulative cap in this feature (deferred to a future cost-control feature).
- Q: Big-context `groundingEngine.query()` — форма результата? → A: **One item per document** — каждый документ возвращается как отдельный `DocumentContext` (новый тип — см. FR-002 и Key Entities; НЕ перегрузка существующего `GroundingContext`, чей `metadata.chunkIndex` required и не имеет смысла для whole-document) с `metadata.documentId` + `metadata.priority`, `score: 1.0` (uniform — нет релевантности, все доки равны в big-context). Сохраняет границы документов для chat-service и downstream. Минимальные изменения в существующих consumers: vector-mode consumer'ы `GroundingContext[]` не трогаются (additive); chat-service получает второй формат для big-context mode и ветвится по `groundingMode` (что он и так делает для prefix-stable блока, FR-011/T009).
- Q: How is the ~100K-tokens-per-turn cost mitigated via caching? → A: **Delegated to OmniRoute** — the gateway already does prompt/response caching (RTK/semantic cache; `X-OmniRoute-Cost-Saved` header). 028 does NOT implement its own cache; it only orders the prompt so the **doc block is a stable prefix** (ahead of the varying conversation/query) to maximize OmniRoute's hit rate. Plan-time: confirm OmniRoute cache semantics (exact-prefix vs semantic) to order the prompt correctly.
- Q: Should enabling big-context guard against a too-small model window? → A: **Warn at toggle, allow** (FR-014). If the effective model's context window < ~32K (configurable, `BIG_CONTEXT_MIN_WINDOW`), the UI shows a non-blocking warning that big-context will truncate heavily; the operator can still enable it — FR-006 truncation + FR-011 cost/latency visibility are the safety net.

## User Scenarios & Testing

### User Story 1 - Big-context grounding for chat responses (Priority: P1)

As an operator, I want my assistant to ground its responses in the full content of uploaded documents (not just semantically-similar chunks), so that exact prices, phone numbers, product names, and cross-references are always accurate.

**Why this priority**: Directly fixes the #1 quality issue — semantic search misses exact matches. A persona selling embroidered hoodies must quote exact prices (6190₽) from the price list, not approximately-relevant chunks.

**Independent Test**: Upload a PDF with a price table + script phrases. Ask the assistant "сколько стоит худи с вышивкой 15×15?" — verify it returns the exact price (7880₽) from the document, not a hallucination.

**Acceptance Scenarios**:
1. **Given** an assistant with `groundingMode: 'big-context'` and 3 uploaded documents (total ~40 pages), **When** a user asks "какие размеры печати доступны?", **Then** the LLM receives the full text of all 3 documents as context and returns "А6, А5, А4" — the exact list from the price section.
2. **Given** the same assistant, **When** a user asks "сколько стоит доставка?", **Then** the answer is "590₽" — the exact figure, not an approximation.
3. **Given** an assistant with `groundingMode: 'big-context'` and zero documents, **When** a user sends a message, **Then** the LLM responds without grounding (same as today's no-documents path), no error.

---

### User Story 2 - Doc-extraction tuning uses full document context (Priority: P2)

As an operator, I want the doc-extraction tuning pipeline to read the ENTIRE uploaded document (not vector-retrieved chunks) when generating a system prompt, so that the extracted config captures cross-references, multi-section logic, and pricing tables that span pages.

**Why this priority**: The current pipeline passes empty query `''` to `groundingEngine.query()` → embedding adapter returns 400 → draft fails with cryptic error. Big-context mode eliminates the embedding call entirely.

**Independent Test**: Upload the "Быстрые фразы" PDF (46 pages). Run doc-extraction tuning. Verify the generated system prompt references pricing, funnel stages, and response templates from across the document.

**Acceptance Scenarios**:
1. **Given** a persona with documents and `groundingMode: 'big-context'`, **When** tuning `generate` is called with `method: 'doc-extraction'`, **Then** the pipeline concatenates full document texts (not chunks) and feeds them to the LLM for extraction.
2. **Given** the same setup, **When** the pipeline runs, **Then** no call to the embedding adapter is made — zero `/embed` requests.

---

### User Story 3 - Context budget management (Priority: P3)

As the system, I must handle document sets that exceed the configured LLM's context window, by truncating intelligently and warning the operator, so that the LLM call doesn't fail with a context-length error.

**Why this priority**: Production safety — a persona with 200 pages of documents will exceed even Claude's 200K window. The system must degrade gracefully.

**Independent Test**: Upload 50 documents (~500 pages, ~500K tokens). Enable big-context mode. Send a message. Verify the system either truncates with a warning or falls back to vector mode, rather than crashing.

**Acceptance Scenarios**:
1. **Given** documents totaling 300K tokens and a model with 128K context window, **When** a query arrives, **Then** the system truncates to fit (keeping most recent / highest-priority documents), includes a system note "[Context truncated: showing 27 of 50 documents]", and does NOT crash.
2. **Given** the same setup with `truncationStrategy: 'fallback-vector'` configured **and embeddings already built** (eager background job complete, FR-004), **When** total exceeds budget, **Then** the system automatically falls back to vector RAG for that query and logs a warning. If embeddings are not yet built, the query degrades to `'silent'` truncation.

---

## Edge Cases

- **No documents**: LLM responds without grounding — no error, no empty embedding call.
- **Single very large document** (e.g., 500-page manual): Must fit in context window or be truncated with warning. Cannot be "chunked" — whole document or nothing.
- **Mixed document types** (PDF, DOCX, TXT, MD): All must be extractable to plain text. Unsupported types are skipped with a warning.
- **Document updates**: When a document is re-uploaded (replaced), `documents.fullText` is overwritten with the new extraction. When deleted, the document row (including `fullText`) is removed (hard delete). No soft-delete/tombstone for fullText — if the document is gone, its text is gone. Orphaned chunks/embeddings in `document_chunks` are cleaned up **atomically and automatically** by the `ON DELETE CASCADE` foreign key (`document_chunks.document_id → documents.id`). The cascade is enforced at the **PostgreSQL level** (Drizzle schema `models/documents.ts:30-32` declares `onDelete: 'cascade'`, and the SQL migrations `drizzle/0000...sql:381` + `drizzle/0010...sql:122-123` emit the FK with `ON DELETE cascade`) — so ANY hard-delete (ORM, manual SQL, or direct DB client) removes the chunks in the same transaction. No sweep worker is needed or planned; a periodic cleanup job would be redundant belt-on-belt and add background-job overhead for zero benefit.
- **Cost**: Big-context injection is significantly more expensive than vector RAG (100K input tokens vs 4K). Must be opt-in per persona, not global default.
- **Latency**: Processing 100K+ tokens adds ~2-5s to response time. Acceptable for quality, but must be visible to the operator.
- **Mode switch during active query**: If an operator switches `groundingMode` while a chat request is in-flight, the request completes in the mode it started with (snapshot effective mode at query start). The new mode applies to the next request. No partial state, no mid-query switch, no abort.

## Requirements

### Functional Requirements

- **FR-001 (Grounding mode: tenant default + persona override)**: The system MUST support `groundingMode` at TWO levels:
  - **Tenant-level default**: `tenants.groundingMode` (default: `'vector'`). Applies to all personas in the tenant unless overridden.
  - **Persona-level override**: `personas.groundingMode` (nullable). When set, takes precedence over tenant default. When null, inherits tenant default.
  - Effective mode = `personas.groundingMode ?? tenants.groundingMode ?? 'vector'`.

- **FR-002 (Full-text retrieval)**: When effective `groundingMode` is `'big-context'`, `groundingEngine.query()` MUST return one **`DocumentContext`** item per document (NOT a single concatenated blob, NOT the vector-mode `GroundingContext`). Each `DocumentContext` has: `text` = full extracted text of that document (bounded by budget after truncation), `score: 1.0` (uniform — no relevance ranking in big-context), `metadata: { documentId, priority }` (NO `chunkIndex` — a whole document has no chunk). This is an **interface change/addition**, NOT "same type, different semantics": the existing `GroundingContext.metadata` carries `{ documentId, chunkIndex }` with `chunkIndex` **required** (`interfaces/IGroundingEngine.ts:10-17`); overloading it with a fake `chunkIndex` and an out-of-band `priority` would silently break consumers that read `.metadata.chunkIndex`. A new `DocumentContext` type is therefore introduced (additive — `GroundingContext` for vector mode is unchanged). See Key Entities. **Naming note (F8)**: `IGroundingEngine.query(query, tenantId, twinId)` uses `twinId` (`interfaces/IGroundingEngine.ts:27`); spec/plan/data-model use `personaId`/`persona`. `twinId ≡ personaId` — same entity, two names across the boundary. Implementers MUST treat them as identical; no mapping logic.

- **FR-003 (No embedding dependency on retrieval)**: When effective `groundingMode` is `'big-context'`, the retrieval path MUST NOT call the embedding adapter (`/embed` endpoint). 

- **FR-004 (Deferred embeddings on ingest)**: When effective `groundingMode` is `'big-context'`:
  - Ingest stores raw extracted text only — chunking and embedding are SKIPPED.
  - Embeddings for documents lacking them are (re)built as a **background job**, never synchronously at query time, triggered when EITHER the persona switches to `'vector'` mode OR `truncationStrategy: 'fallback-vector'` is enabled (or the persona first exceeds budget). Until that job completes, an over-budget query degrades to `'silent'` truncation (FR-006) instead of blocking on a synchronous re-index.
  - **Embeddings readiness flag**: the lazy background job lifecycle is reflected in `personas.embeddingsStatus` (enum `'idle' | 'processing' | 'completed'`, default `'idle'`). The `lazy-embed-worker` MUST transition the persona's flag `idle → processing` when it picks the job up, and `processing → completed` (or back to `idle` on terminal failure with a logged error) when it finishes. `'fallback-vector'` truncation strategy (FR-006) gates strictly on `embeddingsStatus === 'completed'` — anything else degrades to `'silent'`. This flag is the single source of truth for "are embeddings ready"; do NOT infer readiness by probing `document_chunks`.
  - **Index invalidation on document change (lifecycle gap)**: any operation that changes the persona's document set MUST invalidate `embeddingsStatus` back to `'idle'` — i.e. document **insert**, **fullText update** (re-upload/replace), or **hard delete** (the row is removed; chunk rows cascade). Rationale: a `'completed'` status would otherwise be a lie — the vector index would no longer cover the new/changed/removed doc, and `fallback-vector` would silently serve stale/incomplete results. Resetting to `'idle'` triggers the lazy worker to re-index on the next enabling event (FR-004) and forces `fallback-vector` to degrade to `'silent'` until re-indexing finishes (safe — never stale). The invalidation MUST be transactional with the document write (same DB transaction) so the flag and the doc set cannot diverge. Edge case: if the persona is in `'vector'` mode (where ingest already chunks+embeds synchronously per FR-004), the synchronous path keeps `embeddingsStatus` consistent and the idle-reset is a no-op — but the reset rule applies unconditionally to avoid a mode-dependent bug.
  - When effective `groundingMode` is `'vector'`: ingest does chunking + embedding as today (unchanged).

- **FR-005 (Context budget: auto-detect with manual fallback)**: The context budget MUST be resolved in this order:
  1. **Auto-detect from model**: If the configured LLM model's context window is known (hardcoded table for common models: Claude 200K, GPT-4 Turbo 128K, Gemini 1.5 Pro 1M), budget = contextWindow - systemPromptTokens - maxResponseTokens.
  2. **Manual override**: If auto-detect fails (unknown model) or operator explicitly sets `personas.bigContextMaxTokens`, use that value.
  3. **Global default**: `BIG_CONTEXT_MAX_TOKENS` env var (default: **8000** — deliberately conservative so an unknown model never receives a prompt exceeding its context window; many older/smaller/local models have 8K–16K windows and a 100K prompt would cause immediate upstream 400 errors). The operator SHOULD set this env or the persona-level `bigContextMaxTokens` explicitly when targeting larger-context models. The engine MUST emit a `logger.warn` when the global default is hit for an unknown model, prompting the operator to configure an explicit budget.
  4. **Token counting**: Before sending, the engine MUST resolve an exact prompt token count via a strict cascade:
     1. **Primary**: OmniRoute pre-call endpoint `POST /v1/messages/count_tokens` (Anthropic `count_tokens` format → `input_tokens`). OmniRoute itself falls back to its own internal tiktoken (BPE) count when an upstream provider exposes no count endpoint.
     2. **Offline fallback (Tier 2)**: If the OmniRoute call is unreachable or errors, the engine MUST invoke the local `js-tiktoken` tokenizer (`cl100k_base` encoding) bundled in the repo. This is the preferred offline path — it is accurate for Cyrillic (BPE handles multi-byte tokenization), unlike a raw char heuristic.
     3. **Last-resort (Tier 3)**: Only if `js-tiktoken` itself fails to load or throws (corrupt import, OOM) does the engine fall back to a `chars/4` estimate AND log a `logger.warn`. Do NOT collapse Tier 1 → Tier 3 directly — Cyrillic tokenizes ~2–3 chars/token, so `chars/4` systematically under-counts and risks an upstream context-length 400.
     Compare against the budget reserving a ≥5% safety margin. The engine MUST proceed with the LLM call at every tier — never block the response on a counting-service failure. Plan-time, non-blocking: confirm request shape for non-Claude models, exact base path (`/v1` vs `/api/v1`) for the configured `LLM_PROVIDER_URL`, and the response field name.

- **FR-006 (Truncation behavior: configurable)**: When total document text exceeds the context budget, the system MUST apply the persona's `truncationStrategy`:
  - `'silent'` (default): Truncate to fit. Log a warning for the operator. User sees no indication.
  - `'fallback-vector'`: Automatically fall back to vector RAG for that query — **only if `personas.embeddingsStatus === 'completed'`** (i.e., the lazy background indexing job for this persona has finished and the vector index is complete, see FR-004). If `embeddingsStatus ∈ {'idle', 'processing'}` (job not yet started or still running), the query MUST degrade to `'silent'` truncation for that request and log a `logger.warn` that fallback was skipped due to incomplete embeddings. Rationale: a half-built vector index would silently return partial/missing results. Log the fallback (or the skip).
  - The operator chooses this strategy per-persona in the UI.
  - **Truncation order** (applies to `'silent'`): Documents are kept in descending `documents.priority` (operator-set, default 0), ties broken by most-recent `updatedAt` first. The system fills the budget greedily in that order and drops the remainder. This lets an operator pin critical documents (e.g., the price list) so they are never dropped while the persona is under budget.

- **FR-007 (Embedding adapter retained)**: The BGE-M3 embedding adapter, pgvector chunk storage, and BGE-reranker remain operational as the `'vector'` grounding path and as fallback. They are NOT removed.

- **FR-008 (Model selection)**: The system uses the LLM provider configured for the persona (existing `llm.complete()` path). No separate retrieval model.

- **FR-009 (Doc-extraction integration)**: `DocExtractionPipeline` MUST use big-context retrieval when effective mode is `'big-context'`, eliminating the empty-query embedding bug entirely.

- **FR-010 (Isolation & log redaction)**: Big-context retrieval MUST be scoped to the same tenant **and** persona association as the vector path — a persona never receives another persona's or another tenant's documents. Injected full document text MUST NOT be written to application logs or traces; logging is limited to document IDs, token counts, and truncation decisions. **Logger discipline (F9)**: the new big-context retrieval/truncation path MUST log exclusively via the repo-standard redacting logger (consola `logger`), NEVER via `console.*` — the existing vector retrieval path violates this (`services/grounding/retrieval.ts:114` uses `console.warn`), and big-context MUST NOT repeat the leak; `console.*` writes raw args to stdout bypassing any redaction, so a logged doc body would leak verbatim. Verified by (a) an isolation test — cross-persona retrieval returns zero foreign documents, and (b) a log-scan test — no document body appears in logs, extended to cover the NEW big-context retrieval/truncation path (not just vector mode).

- **FR-011 (Cost observability & operator visibility)**: When effective `groundingMode` is `'big-context'`, the system MUST emit a per-reply metric of injected input tokens (and derived cost) via the existing Langfuse trace, and MUST surface big-context cost + added latency to the operator in the UI — closing the Edge-Case requirement that cost/latency be "visible to the operator". A per-tenant cumulative spend cap is explicitly OUT of scope for this feature (deferred to a future cost-control feature). Note: the cost metric reports token *counts*, consistent with FR-010 log redaction — it MUST NOT embed document text.
  - **Cost reduction is delegated to OmniRoute** (gateway-level prompt/response caching — RTK/semantic cache, `X-OmniRoute-Cost-Saved` header). 028 does NOT implement its own cache. To maximize the hit rate, the engine MUST order the prompt with the injected doc block as a **stable prefix** ahead of the varying query. (Plan-time: confirm OmniRoute cache semantics to order correctly.) **Cache-miss boundary (F10)**: cache hits are per-(persona, doc-set, budget) snapshot — i.e. any change to the doc set, to `documents.priority`, or to the truncation boundary (FR-006 drops/reorders docs by priority+recency when over budget) is an EXPECTED cache-miss boundary, not a bug. The prefix-stable ordering maximizes hits within a stable snapshot; it cannot salvage hits across truncation changes. This is inherent and acceptable — operators editing priorities or uploading new docs should not expect stale-cache answers.

- **FR-012 (Document text extraction at ingest)**: Document ingest MUST extract plain text and store it in `documents.fullText` for big-context retrieval. Extraction libraries:
  - **PDF**: `pdf-parse` for simple text PDFs; for complex PDFs with tables/Cyrillic, a higher-fidelity parser (Docling or `unstructured.io` via API) is recommended but NOT required for initial release. The extraction pipeline MUST be pluggable (strategy pattern) so the parser can be upgraded without changing ingest flow.
  - **DOCX**: `mammoth` (extractRawText) — handles Cyrillic + formatting natively.
  - **TXT/MD**: direct buffer → UTF-8 string.
  - **Unsupported types**: skipped with a warning, `fullText` set to `null`.
  - **Original file**: stored to S3/disk ONLY if the platform requires download/re-download capability. If not needed, the raw file is discarded after extraction (buffer in memory → extract → write `fullText` → discard buffer). This minimizes storage footprint.
  - **No S3 dependency for big-context**: big-context retrieval reads `fullText` from PostgreSQL only. S3/disk is never accessed at query time.

- **FR-013 (Query discipline — no accidental TOAST decompression)**: All `documents` table queries that do NOT need the full text (lists, metadata, counts) MUST explicitly exclude the `fullText` column (no `SELECT *`). Only the big-context retrieval path (`groundingEngine.query()` in big-context mode) fetches `fullText`. This prevents TOAST decompression overhead on routine queries.

- **FR-014 (Model-window adequacy warning)**: When an operator enables `groundingMode: 'big-context'` (tenant or persona level), if the effective model's context window is below a configurable threshold (`BIG_CONTEXT_MIN_WINDOW`, default 32000 tokens), the UI MUST show a **non-blocking** warning — e.g. "Model <name> has only <N>K context; big-context will truncate most documents — choose a large-window model for best results." The toggle is still allowed (truncation per FR-006 + cost/latency visibility per FR-011 are the safety net). Unknown-window models (auto-detect miss, FR-005) skip the check with an info note.

### Key Entities

- **GroundingMode**: Enum `'vector' | 'big-context'`. Stored at two levels: `tenants.groundingMode` (tenant default) and `personas.groundingMode` (nullable override). Effective = persona ?? tenant ?? `'vector'`.
- **GroundingContext** (vector mode, UNCHANGED): existing type — `{ text: string; score: number; metadata: { documentId: string; chunkIndex: number } }` (`interfaces/IGroundingEngine.ts:10-17`). Returned by `groundingEngine.query()` in `'vector'` mode. `chunkIndex` is required and meaningful (one item per chunk). 028 does NOT touch this type.
- **DocumentContext** (big-context mode, NEW): `{ text: string; score: number; metadata: { documentId: string; priority: number } }`. Returned by `groundingEngine.query()` in `'big-context'` mode — one item per document, NO `chunkIndex` (a whole document has no chunk), WITH `priority` (needed for truncation survival order, FR-006). Introduced as a separate type rather than overloading `GroundingContext` with optional fields, because (a) `chunkIndex` is meaningless for a whole doc and would silently `undefined`-break consumers reading it, and (b) chat-service already branches on `groundingMode` for prompt formatting (FR-011/T009) — the type reflects the branch the code already makes. NOTE: `GroundingContext` is currently duplicated — declared in `interfaces/IGroundingEngine.ts:10` (canonical) AND re-declared locally in `services/grounding/retrieval.ts:6-13`. Before adding `DocumentContext`, the duplicate MUST be collapsed to the canonical interface (F4).
- **TruncationStrategy**: Enum `'silent' | 'fallback-vector'`. Per-persona. Controls behavior when documents exceed context budget. `'silent'` truncates with operator log; `'fallback-vector'` switches to vector RAG for that query — gated on `embeddingsStatus === 'completed'`, else degrades to `'silent'`.
- **EmbeddingsStatus**: Enum `'idle' | 'processing' | 'completed'`. Per-persona column (`personas.embeddingsStatus`, default `'idle'`). Single source of truth for "are this persona's lazy embeddings ready for `fallback-vector`?" Driven by `lazy-embed-worker` (`idle → processing → completed`). Prevents fallback from hitting a partial vector index.
- **DocumentFullText**: Cached plain-text extraction of each document, stored as `documents.fullText TEXT` column (engine Drizzle schema, same table as existing document metadata). Populated at ingest time (text extraction already runs for chunking — just store the pre-chunk text). No separate table, no extra join. Chunks remain in `document_chunks` for vector fallback, generated lazily per FR-004. **PostgreSQL TOAST**: the `fullText` column automatically uses TOAST for rows > 2KB (compression + out-of-line storage). Column compression MUST be set to `lz4` (PG 14+) for fast decompression on big-context SELECT — `ALTER TABLE documents ALTER COLUMN full_text SET COMPRESSION lz4`. **Query discipline**: list/metadata queries MUST NOT `SELECT fullText` — only fetch it in the big-context retrieval path (avoids TOAST decompression overhead on every query).
- **DocumentPriority**: Per-document integer `documents.priority` (default 0, operator-set). Controls truncation survival order under `'silent'` strategy (higher = kept first; ties broken by most-recent `updatedAt`).
- **ContextBudget**: Runtime-resolved token limit. Source priority: persona override → model auto-detect → `BIG_CONTEXT_MAX_TOKENS` env default.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Persona with `groundingMode: 'big-context'` answers factual questions (prices, names, phone numbers) with high accuracy against the source document. NOTE: LLM output is non-deterministic, so "100% accuracy" is not directly assertable; SC-001 is verified via **golden-Q&A regression** (task T024) — a fixed doc set with known exact answers, asserting the model's reply contains the expected exact token (e.g. `7880₽`, `+7 495 ...`) with a configurable pass threshold across N runs. The criterion's hard clause is "the correct document is grounded" (deterministic, asserted via trace); the exact-match rate is a measured metric with a threshold, not a boolean gate.
- **SC-002**: Doc-extraction tuning on a 46-page PDF completes successfully without embedding adapter calls — zero `/embed` requests during pipeline run.
- **SC-003**: Document set exceeding context window (300K+ tokens) degrades gracefully — truncated context with warning, no crash, no 500 error.
- **SC-004**: Big-context mode adds ≤ 3s latency compared to vector mode on a 20-page document set (measured end-to-end chat response time).
- **SC-005**: Every big-context reply records its injected input-token count (and derived cost) in the Langfuse trace, and the operator can view per-persona big-context cost + added latency in the UI.
