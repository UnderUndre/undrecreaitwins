# Feature Specification: Feedback Loop Closure (Prompt-Time Retrieval)

**Feature Branch**: `019-feedback-loop-closure`
**Created**: 2026-06-14
**Status**: CLARIFIED (session 2026-06-14)
**Repo**: `undrecreaitwins` (Engine). Cross-repo pair: ai-twins `021-dialog-analysis-tools` (Product annotation UI).
**Input**: Brainstorm "assistant self-improvement via feedback" — Phase 1 priority.

## Overview

The engine has `feedback_memories` storage (spec 017) with BGE-M3 vector embeddings, LLM-distilled `lesson` text, `operator_role` weighting, and `status: pending→active` approval gate. Operators can submit corrections. **But corrections don't reach the live reply path** — the loop is open. Storage exists, retrieval into prompt does not.

This spec closes the loop: before generating a reply, retrieve top-K relevant `feedback_memories` via vector search, inject as operating instructions into the system prompt alongside persona + RAG docs. Also defines the **prompt composition contract** that resolves conflicts between three correction mechanisms: `feedback_memories` (freeform lessons), RAG documents (knowledge base), and `CorrectionRule` DAR pipeline (spec 018 structural gates).

**Scope**:
- Prompt-time feedback retrieval (BGE-M3 vector search on `feedback_memories.context_embedding`)
- Prompt composition contract (persona + feedback + RAG + correction rules — layering order, token budget, conflict resolution)
- Integration into `chat-service.ts` reply path (non-streaming Phase 1)
- `status: active` filter — only approved feedback fires in production prompts
- Admin observability: which feedback memories were retrieved and applied per reply (Langfuse trace)

**Out of scope**:
- Client-facing annotation UI (Product spec 021)
- Automated quality detection / LLM-as-judge mining (future spec)
- Conversation-level rubric evaluation (spec 018 Phase 2)
- Streaming path (deferred, same as 004/018)

## Clarifications

### Session 2026-06-14

- **Q: Retrieval query — what text do we embed to find relevant feedback?** → A: **Last user message + current conversation stage/topic**. Embed the user's latest message, search `feedback_memories.context_embedding` with cosine similarity. If conversation has a topic label (from funnel stage classification), append it to the query for better recall.
- **Q: Top-K — how many feedback memories per reply?** → A: **Top-3 by similarity × recency × weight** (spec 017 already defines weight = `operator_role` × recency decay). Cap at 3 to avoid prompt bloat (spec 017 FR for "feedback prompt bloat" says >5 matches → select top-2-3).
- **Q: Token budget — how to allocate across persona + feedback + RAG + correction rules?** → A: **Fixed budget per layer**, configurable per-persona with platform defaults:
  - Persona system prompt: ~1500 tokens (hard floor, always present)
  - Feedback memories: ~500 tokens (3 lessons × ~170 tokens each)
  - RAG context: ~2000 tokens (existing budget from spec 005)
  - Correction rules: 0 tokens in prompt (DAR pipeline operates post-generation, not in prompt — spec 018)
  - **Total system prompt budget: ~4000 tokens** (configurable via persona `systemPromptBudget`)
- **Q: Conflict — feedback says "be formal", CorrectionRule says "casual for Avito"?** → A: **Channel context wins**. Feedback memories are retrieved by semantic similarity to the current message — if the message is from Avito, feedback tagged for Avito context is retrieved. CorrectionRules (spec 018) operate post-generation (DAR pipeline), so they can override the generated text regardless. No conflict in the prompt itself — feedback shapes generation, CorrectionRule shapes post-generation.
- **Q: Score-only (dry-run) feedback retrieval — do we show what WOULD have been applied?** → A: **No**. All `status: active` feedback is applied live. `status: pending` feedback is never retrieved. The "what would have changed" question is answered by the Langfuse trace (shows retrieved memories) + the calibration dashboard in Product (spec 019).
- **Q: Same feedback memory retrieved every message — fatigue?** → A: **Dedup within conversation**. Track `appliedFeedbackIds` in conversation state. If a memory was applied in the last 3 messages, skip it (assume the model already internalized it). Reset on stage transition.

### Session 2026-06-14 (Clarify Round 2)

- **Q: Конфликт ПО СОДЕРЖАНИЮ feedback vs persona vs RAG в одном промпте?** → A: **Precedence: RAG-факты > feedback > persona-дефолты.** RAG-факты = ground truth (feedback не может им противоречить — фактическая привязка побеждает); feedback (оператор-curated коррекция) перекрывает persona-дефолты/стиль. Закодировать явным порядком слоёв в `prompt-composer` + директивой модели («factual grounding from RAG is authoritative; operator lessons override default persona style; never contradict grounded facts»). Закрывает оставшуюся ось «conflict resolution» из Overview (feedback↔CorrectionRule уже решён Round 1).
- **Q: Где хранится `appliedFeedbackIds`?** → A: **Postgres `conversation_states`** (убрать «или equivalent»). Дурабельно, переживает рестарт, консистентно при мульти-воркере (сообщения одного диалога могут попасть на разные инстансы).
- **Q: Observability — Langfuse trace или Engine endpoint?** → A: **Оба.** Langfuse-trace (FR-005) обязателен. Плюс Engine выставляет read-endpoint (FR-010) для структурного запроса «какие лессоны применены» — Product не привязан жёстко к Langfuse.
- **Q: Как детектится stage transition для reset dedup (и что без воронки)?** → A: **Смена funnel-стадии 003 + N-fallback.** Reset при смене stage-label из 003; для разговоров без воронки (free-chat, нет стадий) — fallback: reset каждые N сообщений (дефолт = dedup-окно, 3). Не ломаемся без 003.

## User Scenarios & Testing

<<<<<<< HEAD
### User Story 1 — Seeded correction improves next reply (Priority: P1)

**Given** a seeded active `feedback_memories` row (ingestion/write path = future spec — see Dependencies), **when** the twin would exhibit the corrected behavior, the feedback memory is retrieved (vector similarity to the user message context) and injected into the prompt.

> **⚠️ Scope note (review F2)**: 019 implements the **read/retrieval path only**. The ingestion path (operator submits correction → LLM-distill → embed → store) is a **future spec** (Product: ai-twins 021 annotation UI + Engine ingestion endpoint). For 019 testing, memories are seeded via SQL. US1 is scoped to "given a seeded memory" — end-to-end "operator submits → reply changes" requires the ingestion spec.

**Independent Test**: Seed a feedback memory with a clear lesson via SQL. Send a message that would trigger the old behavior. Confirm: (a) the feedback memory appears in the Langfuse trace as "retrieved", (b) the generated reply reflects the correction.
=======
### User Story 1 — Operator correction improves next reply (Priority: P1)

An operator notices the twin keeps calling customers "Уважаемый клиент" (too formal). Operator submits feedback: lesson = "Не используй 'Уважаемый клиент' — обращайся по имени или дружелюбно". Lesson is LLM-distilled, embedded, `status: active`. On the next reply where the twin would say "Уважаемый клиент", the feedback memory is retrieved (vector similarity to the user message context) and injected into the prompt. The twin says "Алексей, ..." instead.

**Independent Test**: Submit a feedback memory with a clear lesson. Send a message that would trigger the old behavior. Confirm: (a) the feedback memory appears in the Langfuse trace as "retrieved", (b) the generated reply reflects the correction.
>>>>>>> main

**Acceptance Scenarios**:
1. **Given** an active feedback memory matching the current message context, **When** the reply is generated, **Then** the memory is retrieved and injected into the system prompt, and the reply reflects the lesson.
2. **Given** a pending (not yet approved) feedback memory, **When** the reply is generated, **Then** the memory is NOT retrieved (status filter).
3. **Given** 3+ relevant feedback memories, **When** retrieval runs, **Then** only top-3 by similarity × weight are injected.

### User Story 2 — Prompt composition budget enforcement (Priority: P1)

A persona has 2000 tokens of system prompt + 5 relevant feedback memories + 3 RAG chunks. The total would exceed the model's context window. The composition layer allocates budget: full persona (2000), top-2 feedback (340 tokens), top-2 RAG chunks (remaining budget). The reply generates successfully.

**Independent Test**: Configure a persona with a large system prompt + many feedback memories + many RAG docs. Send a message that matches all. Confirm the total prompt stays within budget and the reply generates without truncation.

**Acceptance Scenarios**:
1. **Given** total available context = 8192 tokens, persona = 2000, feedback = 5 matches, RAG = 5 chunks, **When** composition runs, **Then** layers are allocated within budget (persona full, feedback capped at ~500, RAG gets remainder).
2. **Given** persona system prompt exceeds its budget, **When** composition runs, **Then** error is logged and persona is truncated to budget (hard floor = 500 tokens minimum).

### User Story 3 — Dedup prevents feedback fatigue (Priority: P2)

A feedback memory "don't promise discounts" is retrieved for message 1, 2, 3 in the same conversation. After message 1, it's marked as `appliedFeedbackIds`. Messages 2-3 skip it. On stage transition (greet → qualify), the dedup resets.

**Independent Test**: Send 3 messages that match the same feedback memory. Confirm it's injected on message 1 but not 2-3.

## Functional Requirements

<<<<<<< HEAD
- **FR-001**: Feedback retrieval service — new module `packages/core/src/services/feedback-retrieval.ts`. Method: `retrieveRelevant(tenantId, personaId, queryText, conversationState): Promise<FeedbackMemory[]>`. Uses BGE-M3 embedding service to embed `queryText`, searches `feedback_memories` with cosine similarity > 0.75, filters `status = 'active'`, `tenantId` match, returns top-3 by composite score. **Scoring formula**: `cosine_similarity × operator_role_weight × recency_decay`, where `recency_decay = exp(-days_since_created / 30)` (exponential, 30-day half-life).
=======
- **FR-001**: Feedback retrieval service — new module `packages/core/src/services/feedback-retrieval.ts`. Method: `retrieveRelevant(tenantId, personaId, queryText, conversationState): Promise<FeedbackMemory[]>`. Uses BGE-M3 embedding service to embed `queryText`, searches `feedback_memories` with cosine similarity > 0.75, filters `status = 'active'`, `tenantId` match, returns top-3 by similarity × `operator_role` weight × recency decay.
>>>>>>> main
- **FR-002**: Dedup — `retrieveRelevant` accepts `appliedFeedbackIds: string[]` from conversation state. Memories in this list are excluded from results for the current stage. Reset trigger per FR-006 (funnel stage-label change from 003; N-message fallback for non-funnel conversations).
- **FR-003**: Prompt composition service — new module `packages/core/src/services/prompt-composer.ts`. Method: `compose({ persona, feedbackMemories, ragChunks, conversationContext }): ComposedPrompt`. Allocates token budget per layer (persona hard floor, feedback cap ~500 tokens, RAG remainder). Returns composed system prompt string + metadata (which memories were included, token counts per layer). **Content-conflict precedence (CL Round 2)**: при противоречии по содержанию — **RAG-факты > feedback > persona-дефолты**. Composer (a) располагает слои в этом порядке и (b) добавляет директиву: «factual grounding from RAG is authoritative; operator feedback lessons override default persona style but MUST NOT contradict grounded facts». (Ось feedback↔CorrectionRule — пост-генерация, DAR 018, не в промпте.)
- **FR-004**: Integration into `chat-service.ts` — after existing RAG retrieval (spec 005) and before `LLMClient.complete()` call, invoke `feedback-retrieval.retrieveRelevant()`, then `prompt-composer.compose()`. Replace the current system prompt construction with the composed output.
- **FR-005**: Langfuse trace enrichment — add `feedback_memories_retrieved` span to the existing Langfuse trace. Includes: memory IDs, similarity scores, lesson text (truncated), token budget allocation per layer.
<<<<<<< HEAD
- **FR-006**: Conversation state tracking — add `appliedFeedbackIds: string[]` to the conversation state, stored in the **Postgres `conversation_feedback_states` table** (CL Round 2 — durable, multi-worker-consistent; не in-memory; separate from `conversation_funnel_states` which only exists for funnel conversations). Updated after each reply with the IDs of injected memories. **Reset trigger (review G-F3)**: reset on funnel stage-label change (003) **OR** every N messages (`FEEDBACK_DEDUP_RESET_MESSAGES`, default 3) — whichever comes first, for ALL conversations (funnel + non-funnel). Prevents feedback loss in long funnel stages (50+ messages without stage transition).
=======
- **FR-006**: Conversation state tracking — add `appliedFeedbackIds: string[]` to the conversation state, stored in the **Postgres `conversation_states` table** (CL Round 2 — durable, multi-worker-consistent; не in-memory). Updated after each reply with the IDs of injected memories. **Reset trigger (CL Round 2)**: смена funnel stage-label (003) → reset; разговор без воронки (нет stage) → fallback reset каждые N сообщений (default N = dedup-окно = 3, env `FEEDBACK_DEDUP_RESET_MESSAGES`).
>>>>>>> main
- **FR-007**: Per-persona config — add `feedbackRetrievalEnabled: boolean` (default true) and `feedbackTokenBudget: number` (default 500) to persona config. Operators can disable feedback retrieval for specific personas (e.g., during A/B testing).
- **FR-008**: Error handling — if feedback retrieval fails (embedding service down, DB error), the reply proceeds WITHOUT feedback memories (graceful degradation). Log warning. Never block reply on feedback retrieval.
- **FR-009**: Empty feedback set — if no `status: active` feedback memories exist for the tenant/persona, retrieval is a no-op (zero vector search calls). Skip entirely.
- **FR-010**: Retrieved-feedback observability endpoint (CL Round 2 — «Both») — in addition to the Langfuse trace (FR-005), Engine exposes a read endpoint `GET /v1/internal/retrieved-feedback?conversationId=<id>` (or `&messageId=`) returning per-reply applied memory IDs + similarity scores + token allocation. Auth: dedicated internal secret (mirror 018 `TWIN_INTERNAL_WEBHOOK_SECRET` pattern) + `X-Tenant-ID`; tenant-scoped. Lets Product query "which lessons applied" without coupling to Langfuse.

## Non-Functional Requirements

- **NFR-1 (latency)**: feedback retrieval adds < 50ms p95 to the reply path (BGE-M3 embedding ~10ms + pgvector HNSW search ~20ms + composition ~5ms). Total system prompt construction < 100ms.
- **NFR-2 (isolation)**: feedback retrieval scoped by `tenantId` via `withTenantContext`. Cross-tenant feedback is never accessible. Vector index is per-tenant (RLS on `feedback_memories`).
- **NFR-3 (reliability)**: feedback retrieval failure → graceful degradation (reply without feedback). RAG and persona prompt remain intact. No retry needed — next reply will retry.
- **NFR-4 (observability)**: every reply's Langfuse trace includes feedback retrieval span. Product admin sees "which lessons were applied" via **both** (CL Round 2): (a) Langfuse trace span (FR-005), and (b) Engine read endpoint `GET /v1/internal/retrieved-feedback` (FR-010, internal-secret auth, tenant-scoped) — Product not hard-coupled to Langfuse.
- **NFR-5 (token budget)**: composed prompt must fit within the persona's `systemPromptBudget`. Hard floor: persona prompt minimum 500 tokens. Feedback + RAG share the remainder.

## Edge Cases

- **Feedback memory references a deleted persona** → excluded by `personaId` filter. Orphaned memories don't fire.
- **Feedback memory `lesson` text is empty** → excluded (validation at creation per spec 017, but defensive check at retrieval).
- **All feedback memories are `status: pending`** → retrieval returns empty. Reply proceeds without feedback. No error.
- **Vector index empty (no memories at all)** → skip embedding call + skip vector search. Zero-cost no-op.
- **Feedback memory is very long (> 500 tokens)** → truncated to 170 tokens (budget per memory) at composition time. Truncation logged.
- **RAG and feedback compete for same budget** → feedback gets priority allocation (it's operator-curated), RAG gets remainder. If RAG budget < 200 tokens, skip RAG for this reply (better no RAG than truncated context).
- **Stage transition mid-conversation** → `appliedFeedbackIds` resets. Same feedback memory can be re-applied in the new stage.
- **Embedding service (TEI) down** → feedback retrieval skipped (graceful degradation). RAG also affected (same embedding service) — both degrade together. Reply proceeds with persona-only prompt.
<<<<<<< HEAD
- **Prompt-injection via operator lesson (review F6)** → `lesson` is operator-authored free text injected into the system prompt. A compromised/careless lesson could steer generation. Mitigation: lessons wrapped in a delimited block (`<operator_lessons>...</operator_lessons>`); system prompt instructs LLM to treat them as behavioral corrections, not system commands. Operator trust boundary = tenant admin role (same as all Product config).
- **PII in feedback memories (review F8)** → `feedback_memories` stores `lesson`, `userQuery`, `wrongResponse`, `correctedResponse` — customer conversation content. TLS-in-transit assumed (HTTPS). Product responsible for at-rest retention + right-to-erasure. `GET /v1/internal/retrieved-feedback` returns IDs + scores by default; `lesson` text optional (can be redacted). `archived` status is for cap-200 rotation, NOT PII lifetime.
- **Bot-initiated message, no user query (review G-F2)** → in proactive flows (bot starts conversation), there is no user message to embed for feedback retrieval. Fallback: use the persona's stage objective/topic as the retrieval query, or skip feedback retrieval for bot-initiated turns (empty query → no-op per FR-009).
- **Query/index embedding asymmetry (review F12)** → memories are indexed on `context_embedding` (the correction's triggering context), retrieval embeds the current user message. Different semantic roles may reduce recall. Phase 1 accepts this asymmetry; Phase 2 may add a user-message-context embedding column for better recall matching.

## Key Entities

- **FeedbackMemory** (spec 017-hybrid-agent-core, Engine naming): `{ id, tenantId, personaId, contextEmbedding, lesson, status, operatorRole, weight, ... }`. Read-only in this spec. (Note: 017/Product naming uses `assistantId` — same entity as Engine `personaId`; `personas` table = `assistants` in Product.)
=======

## Key Entities

- **FeedbackMemory** (existing, spec 017): `{ id, tenantId, assistantId, contextEmbedding, lesson, status, operatorRole, weight, ... }`. Read-only in this spec.
>>>>>>> main
- **ComposedPrompt** (new): `{ systemPrompt: string, layers: { persona: TokenInfo, feedback: TokenInfo, rag: TokenInfo }, retrievedMemories: FeedbackMemory[], totalTokens: number }`.
- **ConversationState extension** (existing): add `appliedFeedbackIds: string[]` to the state object persisted per conversation.

## Dependencies

<<<<<<< HEAD
- **017-hybrid-agent-core** (prerequisite, in ai-twins repo): `feedback_memories` table design + embeddings + `status` + `operator_role` weight. **Table designed in 017 Phase 2 but NOT yet implemented** — no migration, no model, no code. 019 includes table creation as Phase 0 Foundational, aligned with 017 data-model.md schema.
=======
- **017-hybrid-agent-core** (prerequisite): `feedback_memories` table + embeddings + `status` + `operator_role` weight. All built, needs wiring.
>>>>>>> main
- **005-fact-grounding** (existing): RAG retrieval. Prompt composer must allocate budget alongside RAG.
- **018-response-quality-rules** (existing, just shipped): DAR pipeline operates post-generation. No conflict — feedback shapes generation, CorrectionRule shapes post-generation.
- **BGE-M3 embedding service** (TEI sidecar): shared with RAG. Same embedding model for feedback query + indexed memories.

## Success Criteria

- **SC-001**: Operator submits feedback → next relevant reply reflects the correction (verified via Langfuse trace showing retrieved memory + reply content change).
- **SC-002**: Composed prompt stays within persona budget — zero "context length exceeded" errors from feedback injection.
- **SC-003**: Feedback retrieval adds < 50ms p95 latency to reply path.
- **SC-004**: `status: pending` memories NEVER appear in production prompts (100% guarantee).
- **SC-005**: Same memory not injected twice in the same conversation stage (dedup works).
- **SC-006**: Feedback retrieval failure does NOT block reply delivery (graceful degradation verified).

## Glossary

- **Feedback memory** — operator-submitted correction, LLM-distilled into a `lesson`, embedded for semantic retrieval. Spec 017.
- **Prompt composition** — the process of assembling the final system prompt from persona + feedback + RAG layers within a token budget.
- **Dedup** — preventing the same feedback memory from being injected multiple times in the same conversation stage.
- **Budget allocation** — fixed token cap per prompt layer (persona, feedback, RAG) to prevent context window overflow.
<<<<<<< HEAD

## Which Correction Mechanism When (review F13)

Four mechanisms shape assistant responses. Decision guide for operators/PMs:

| Mechanism | Spec | When to use | How it works |
|-----------|------|-------------|--------------|
| **Feedback memory** | 019 (this) | Operator noticed a **recurring behavioral pattern** to correct (e.g., "too formal", "doesn't close objections") | Injected into system prompt **before generation** as a lesson. Shapes how the LLM generates. |
| **CorrectionRule** | 018 | Operator needs **deterministic detection + rewrite** of specific artifacts (e.g., "remove em-dashes", "block off-topic") | DAR pipeline runs **after generation**. Detects pattern, rewrites text. Gate (rewrite) or advisory (score). |
| **Annotation** | 008 | Operator has **good/bad response pairs** to teach style via few-shot | Few-shot examples injected into prompt **before generation**. Shows desired style by example. |
| **RAG document** | 005 | Operator needs **factual knowledge** in responses (product specs, pricing, policies) | Document chunks retrieved and injected as **ground truth** in the prompt. Authoritative facts. |
=======
>>>>>>> main
