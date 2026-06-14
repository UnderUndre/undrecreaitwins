# Implementation Plan: 019 Feedback Loop Closure (Prompt-Time Retrieval)

**Branch**: `specs/018-response-quality-rules` (worktree: `019-feedback-loop-closure`) | **Date**: 2026-06-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature spec + 017 codebase audit + 005 RAG patterns + 003 funnel stage detection

## Summary

Close the feedback loop: before generating a reply, retrieve top-K relevant `feedback_memories` via pgvector cosine search, inject as operator lessons into the system prompt alongside persona + RAG docs. Define the **prompt composition contract** that resolves conflicts (RAG-facts > feedback > persona-defaults). Add dedup within conversation stage + reset on funnel stage transition.

**⚠️ CRITICAL prerequisite gap**: The spec claims `feedback_memories` table exists (dependency "017-hybrid-agent-core — all built, needs wiring"). **Partially incorrect.** Spec 017-hybrid-agent-core lives in the **Product repo** (`ai-twins/specs/017-hybrid-agent-core/`), and its `data-model.md` defines `feedback_memories` as **Phase 2 tables (NOT in the initial migration)**. The table schema is designed but NOT implemented — no Prisma model, no SQL migration applied, no TypeScript code. Migration `0011_hybrid_agent_core_schema.sql` (017 Phase 1) creates only `delivery_records` + `llm_retry_jobs`. This plan includes the table creation as Phase 0 Foundational, aligning with the 017 Phase 2 design.

## Technical Context

**Language/Version**: TypeScript 5.x, Node 20
**Primary Dependencies**: Drizzle ORM (PostgreSQL + pgvector), Fastify, pino, Langfuse, TEI sidecar (BGE-M3 embeddings)
**Storage**: PostgreSQL — NEW table `feedback_memories` (vector + metadata) + NEW table `conversation_feedback_states` (dedup tracking) + MODIFY `personas` (config fields)
**Testing**: Vitest (unit + integration). Mock EmbeddingService for retrieval tests. Mock vector search for composition tests.
**Target Platform**: Linux server (Docker, Node 20)
**Project Type**: Monorepo backend (`packages/core` + `packages/api`)
**Performance Goals**: Feedback retrieval adds < 50ms p95 (BGE-M3 embed ~10ms + pgvector HNSW ~20ms + composition ~5ms). Total prompt construction < 100ms.
**Constraints**: Non-streaming path only (same as 004/018). Graceful degradation — feedback failure never blocks reply. Only `status: active` memories retrieved.
**Scale/Scope**: ~10 new files, ~1400 LOC (includes table creation that spec assumed existed)

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Source of Truth | N/A | Engine runtime feature |
| IV. SemVer | N/A | Engine repo |
| VI. Cross-AI Review | PENDING | Needs ≥2 external reviewers before implement |
| VII. Artifact Versioning | TODO | Snapshot after plan + tasks |

## What Already Exists (Reuse)

| Capability | Status | Key Files |
|---|---|---|
| pgvector cosine search + HNSW | IMPLEMENTED | `packages/core/src/services/grounding/retrieval.ts:44-59` — `<=>` operator, `withTenantContext`, HNSW index |
| EmbeddingService (BGE-M3) | IMPLEMENTED | `packages/core/src/services/embedding-service.ts:22` — `embed(text): Promise<number[]>` (1024-dim) |
| Token estimation pattern | IMPLEMENTED | `retrieval.ts:101` — `Math.ceil(text.length / 4)` |
| `buildSystemPrompt()` | IMPLEMENTED | `chat-service.ts:877-984` — assembly: persona → traits → annotation → RAG → funnel. **Insertion point: after line 946 (RAG), before 948 (funnel).** |
| Funnel stage transition | IMPLEMENTED | `funnel-runtime.ts:187` — `metadata.stage_transition = { from, to, type }`. Accessible via `funnelResult.metadata` in chat-service. |
| RAG retrieval + budget packing | IMPLEMENTED | `retrieval.ts:26-113` — budget = 2000 tokens, packing loop |
| Drizzle `vector` type | IMPLEMENTED | `packages/core/src/models/types.ts:7` — `vector(1024)` for BGE-M3 |
| `withTenantContext` | IMPLEMENTED | `packages/core/src/db.ts:18` — RLS via `app.current_tenant` |
| Persona model (extensible) | IMPLEMENTED | `packages/core/src/models/personas.ts:22` — `jsonb` config fields, straightforward to add columns |
| Langfuse trace | IMPLEMENTED | `packages/core/src/services/langfuse-service.ts` — fire-and-forget spans |
| Annotations table (pattern ref) | IMPLEMENTED | `packages/core/src/models/annotations.ts` — same `vector` + `tenantId` + `personaId` pattern |

## What Needs Building (Gap Analysis)

### Phase 0: Prerequisite — Storage Layer (NOT in spec's assumed scope)

**⚠️ The spec assumes `feedback_memories` exists. It does not. This phase creates it.**

1. **`feedback_memories` table** — Drizzle model + migration SQL (review-only per Standing Order #5)
   - Columns: `id`, `tenantId`, `personaId`, `contextEmbedding` (vector 1024), `lesson` (text), `status` (enum: `pending`/`active`), `operatorRole` (text), `weight` (real), `sourceConversationId` (nullable), `createdAt`, `updatedAt`
   - HNSW index on `contextEmbedding` using `vector_cosine_ops`
   - Index on `(tenantId, personaId, status)` for filtered retrieval
   - RLS via `tenantId` (same as all tables)
   - **Files**: `packages/core/src/models/feedback-memories.ts` (NEW), `drizzle/0011_feedback_memories.sql` (NEW, review-only)

2. **`conversation_feedback_states` table** — for `appliedFeedbackIds` dedup tracking
   - Columns: `conversationId` (PK, FK → conversations), `appliedFeedbackIds` (jsonb array), `messageCount` (int), `updatedAt`
   - Separate from `conversation_funnel_states` (which only exists for funnel conversations; feedback dedup applies to ALL conversations)
   - **Files**: `packages/core/src/models/conversation-feedback-states.ts` (NEW), `drizzle/0011_feedback_memories.sql` (same migration)

3. **Persona config extension** — add `feedbackRetrievalEnabled` + `feedbackTokenBudget`
   - **Files**: `packages/core/src/models/personas.ts` (MODIFY), `drizzle/0011_feedback_memories.sql` (ALTER TABLE)

### Phase 1: Types & Interfaces

4. **Types module** — `packages/core/src/services/feedback/types.ts`
   - `FeedbackMemory` (DB row shape), `ComposedPrompt`, `TokenInfo`, `FeedbackRetrievalResult`

### Phase 2: Feedback Retrieval Service

5. **`feedback-retrieval.ts`** — `packages/core/src/services/feedback/feedback-retrieval.ts`
   - `retrieveRelevant(tenantId, personaId, queryText, conversationState): Promise<FeedbackMemory[]>`
   - Embed queryText via EmbeddingService
   - pgvector cosine search on `feedback_memories.context_embedding` with similarity > 0.75
   - Filter: `status = 'active'`, `tenantId` match (RLS), `personaId` match
   - Exclude `appliedFeedbackIds` (dedup from conversation state)
   - Score: similarity × `operatorRole` weight × recency decay
   - Return top-3
   - Graceful degradation: embedding service down → return empty array, log warning

### Phase 3: Prompt Composition Service

6. **`prompt-composer.ts`** — `packages/core/src/services/feedback/prompt-composer.ts`
   - `compose({ persona, feedbackMemories, ragChunks, conversationContext }): ComposedPrompt`
   - Budget allocation: persona hard floor (min 500 tokens), feedback cap (~500 tokens, 3 × ~170), RAG remainder
   - **Content conflict precedence (CL Round 2)**: RAG-facts > feedback > persona-defaults
   - Layer ordering in the prompt: RAG first (authoritative), then feedback (operator corrections), then persona (style defaults)
   - Conflict directive: `"factual grounding from RAG is authoritative; operator feedback lessons override default persona style but MUST NOT contradict grounded facts"`
   - Truncate feedback memories > 170 tokens each
   - **Files**: `packages/core/src/services/feedback/prompt-composer.ts` (NEW)

### Phase 4: Chat-Service Integration

7. **Integration into `buildSystemPrompt`** — at `chat-service.ts:946` (after RAG, before funnel)
   - Check `persona.feedbackRetrievalEnabled` (skip if false)
   - Call `feedback-retrieval.retrieveRelevant()`
   - Call `prompt-composer.compose()` with persona prompt + feedback + RAG chunks
   - Replace the current `parts.push(...)` assembly with composed prompt sections
   - Update `conversation_feedback_states.appliedFeedbackIds` after retrieval
   - Detect stage transition from `funnelResult.metadata.stage_transition` → reset dedup
   - Non-funnel conversations: reset every N messages (env `FEEDBACK_DEDUP_RESET_MESSAGES`, default 3)
   - **Files**: `packages/core/src/services/chat-service.ts` (MODIFY)

### Phase 5: Observability

8. **Langfuse trace enrichment** — add `feedback_memories_retrieved` span
   - Memory IDs, similarity scores, lesson text (truncated), token budget allocation per layer
   - **Files**: `packages/core/src/services/chat-service.ts` (MODIFY — trace emit)

9. **Engine read endpoint** — `GET /v1/internal/retrieved-feedback?conversationId=<id>`
   - Auth: dedicated internal secret (mirror 018 `TWIN_INTERNAL_WEBHOOK_SECRET` pattern) + `X-Tenant-ID`
   - Returns per-reply applied memory IDs + similarity scores + token allocation
   - Lets Product query "which lessons applied" without coupling to Langfuse
   - **Files**: `packages/api/src/routes/retrieved-feedback.ts` (NEW), `packages/api/src/server.ts` (MODIFY — register)

### Phase 6: Tests

10. **Unit tests** — feedback retrieval (mock embedding + mock vector search), prompt composer (budget allocation, conflict directive, truncation), dedup reset logic
11. **Integration test** — full flow: feedback memory → retrieval → composition → prompt includes lesson

## Cross-Repo Product Contract

| Endpoint | Direction | Purpose |
|----------|-----------|---------|
| `POST /v1/feedback-memories` | Product → Engine | Product submits operator corrections → Engine distills lesson, embeds, stores `feedback_memories` row (status=pending). *(Not in 019 scope — future Product annotation spec 021. Included here for contract completeness.)* |
| `GET /v1/internal/retrieved-feedback?conversationId=<id>` | Product → Engine | Product queries "which lessons applied" for observability. Internal secret auth. |

**⚠️ Feedback memory ingestion** (the write path: operator submits correction → LLM distill → embed → store) is NOT in 019 scope. 019 is the READ path (retrieval + composition). The write path is a future spec (or part of Product 021). For 019 to be testable, memories must be insertable — either via direct DB seed or a minimal ingestion endpoint.

## Project Structure

```text
packages/core/src/models/
├── feedback-memories.ts               # NEW: feedback_memories table (pgTable + vector + indexes)
├── conversation-feedback-states.ts    # NEW: dedup tracking table
├── personas.ts                        # MODIFY: add feedbackRetrievalEnabled + feedbackTokenBudget columns
└── index.ts                           # MODIFY: re-export new models

packages/core/src/services/feedback/
├── types.ts                           # NEW: FeedbackMemory, ComposedPrompt, TokenInfo
├── feedback-retrieval.ts              # NEW: vector search + dedup + weight/recency scoring
├── prompt-composer.ts                 # NEW: budget allocation + layer ordering + conflict directive
└── __tests__/
    ├── feedback-retrieval.test.ts     # NEW: mock embedding + mock search, dedup, graceful degradation
    └── prompt-composer.test.ts        # NEW: budget allocation, conflict directive, truncation

drizzle/
└── 0011_feedback_memories.sql         # NEW: CREATE TABLE feedback_memories + conversation_feedback_states + ALTER personas

packages/api/src/routes/
└── retrieved-feedback.ts              # NEW: GET /v1/internal/retrieved-feedback

packages/api/src/server.ts             # MODIFY: register retrieved-feedback route

packages/core/src/services/chat-service.ts  # MODIFY: integrate feedback retrieval + composition at line 946
```

**Structure Decision**: New `feedback/` service directory under `packages/core/src/services/`. New models in `packages/core/src/models/`. Fastify route in `packages/api/src/routes/`. Integration in `chat-service.ts:buildSystemPrompt()`.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **feedback_memories table not built (spec prerequisite gap)** | **Confirmed** | **Critical** | **This plan includes table creation (Phase 0).** Without it, the entire feature is unimplementable. |
| Feedback memory ingestion (write path) not implemented | High | High | 019 = read path only. For testing, seed memories via DB or minimal endpoint. Write path = future spec/Product 021. |
| Embedding service (TEI) downtime → feedback retrieval fails | Medium | Low | Graceful degradation (FR-008): reply proceeds without feedback. RAG also affected (same TEI). Persona-only prompt as fallback. |
| Prompt token budget overflow | Low | Medium | Prompt composer enforces budget per layer. Hard floor 500 tokens for persona. Feedback truncated to 170 tokens each. |
| Dedup state race condition (multi-worker) | Low | Low | `conversation_feedback_states` in Postgres (not in-memory). Atomic update via optimistic locking (same pattern as `conversation_funnel_states`). |
| Feedback memory references deleted persona | Low | Low | Filter by `personaId` at retrieval. Orphaned memories don't fire (FR-009). |

## Phase 0: Research (Pre-Implementation)

No external research required. The spec is fully clarified (2 clarify rounds). The retrieval approach (pgvector cosine), composition contract (layer precedence), and dedup logic (stage transition + N-fallback) are defined.

**However**: the spec's prerequisite claim is wrong — `feedback_memories` must be built first. This is documented above and addressed in Phase 0 of the plan.

## Env Var Requirements

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `TWIN_INTERNAL_WEBHOOK_SECRET` | YES (shared with 018) | — | Auth for `GET /v1/internal/retrieved-feedback` route. Same secret as 018 rules-reload. |
| `FEEDBACK_DEDUP_RESET_MESSAGES` | NO | `3` | N-message fallback dedup reset for non-funnel conversations. |
| `FEEDBACK_SIMILARITY_THRESHOLD` | NO | `0.75` | Minimum cosine similarity for feedback memory retrieval. |
| `FEEDBACK_TOP_K` | NO | `3` | Max feedback memories retrieved per reply. |
