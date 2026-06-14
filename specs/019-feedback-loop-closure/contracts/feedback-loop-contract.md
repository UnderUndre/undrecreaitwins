# Contract: 019 Feedback Loop Closure — Internal API + Prompt Composition

## 1. Internal Read Endpoint: Retrieved Feedback Observability

### `GET /v1/internal/retrieved-feedback?conversationId=<id>`

**Direction**: Product calls Engine (inbound, read-only)

**Auth**: `Authorization: Bearer <TWIN_INTERNAL_WEBHOOK_SECRET>` + `X-Tenant-ID: <tenantId>`

**Scope (review G-F1)**: Returns the **current** `conversation_feedback_states` for this conversation — i.e., memories applied in the current dedup window. NOT per-message historical data. Per-message history requires Langfuse trace (FR-005). The `messageId` query param is NOT supported in Phase 1.

**Response (200 OK)**:
```json
{
  "conversationId": "uuid",
  "appliedMemories": [
    {
      "memoryId": "uuid",
      "lesson": "Не используй 'Уважаемый клиент' — обращайся по имени",
      "similarityScore": 0.87,
      "weight": 1.2,
      "tokensAllocated": 165
    }
  ],
  "tokenAllocation": {
    "persona": { "tokens": 1500, "truncated": false },
    "feedback": { "tokens": 495, "truncated": false, "itemsIncluded": 3 },
    "rag": { "tokens": 1800, "truncated": true, "itemsIncluded": 2 }
  },
  "totalTokens": 3795
}
```

**Response (404)**: conversation not found or wrong tenant.

**PII / lesson redaction (review F8)**: `lesson` field contains operator-authored text that may reference customer conversation content. By default, the endpoint returns `lesson` text. Add `?redact=true` query param to redact `lesson` (returns `"***"` instead) — for dashboards that don't need the full text. Product is responsible for retention/erasure of feedback PII at rest.

**Shared secret blast radius (review F9)**: `TWIN_INTERNAL_WEBHOOK_SECRET` is shared between 018 `/rules-reload` and this endpoint. One leak compromises both. Accepted for Phase 1 (same trust boundary). Phase 2: per-route secrets.

**Purpose**: Product admin UI can show "which feedback lessons were applied" (current state) without coupling to Langfuse. Langfuse trace (FR-005) is the primary observability path (per-message); this endpoint is the structural query path (current conversation state).

---

## 2. Prompt Composition Contract

The prompt composer assembles the system prompt from three layers in a fixed precedence order:

### Layer Precedence (CL Round 2)

```
RAG-факты (authoritative) > feedback (operator corrections) > persona-дефолты (style)
```

### Assembly Order (in the system prompt)

```
1. [PERSONA] — system prompt + traits (hard floor: 500 tokens minimum)
2. [CONFLICT DIRECTIVE] — "factual grounding from RAG is authoritative;
   operator feedback lessons override default persona style but MUST NOT
   contradict grounded facts"
3. [RAG CONTEXT] — document chunks (ground truth, budget = remainder after persona+feedback)
4. [FEEDBACK LESSONS] — operator corrections (budget = persona.feedbackTokenBudget, default 500)
   Format: "Operator corrections:\n- {lesson1}\n- {lesson2}\n- {lesson3}"
5. [FUNNEL CONTEXT] — stage name, slots, prompt hint (existing, unchanged)
```

### Budget Allocation

| Layer | Budget | Rules |
|-------|--------|-------|
| Persona | `min(persona.systemPrompt tokens, systemPromptBudget - 500)` | Hard floor: 500 tokens. If persona prompt exceeds budget → truncate, log. |
| Feedback | `persona.feedbackTokenBudget` (default 500) | Cap at 3 memories × ~170 tokens each. Each memory truncated if > 170 tokens. |
| RAG | `systemPromptBudget - persona_tokens - feedback_tokens` | If RAG budget < 200 tokens → skip RAG for this reply (better no RAG than truncated). |

**`systemPromptBudget`**: per-persona configurable (default ~4000 tokens). Includes persona + feedback + RAG. Does NOT include funnel context (always appended, small).

### Conflict Resolution

- **RAG vs feedback**: RAG wins. Feedback cannot contradict grounded facts. The conflict directive in the prompt instructs the LLM.
- **Feedback vs persona**: feedback wins. Operator corrections override default persona style.
- **Feedback vs feedback**: dedup prevents same memory from appearing twice. If multiple memories conflict, higher `weight` (similarity × operator_role × recency) wins — top-3 selected.

---

## 3. Feedback Retrieval Contract (Internal Module)

### FeedbackRetrievalService

```typescript
class FeedbackRetrievalService {
  constructor(
    embeddingService: EmbeddingService,
    logger: pino.Logger,
  )

  async retrieveRelevant(
    tenantId: string,
    personaId: string,
    queryText: string,
    conversationState: { appliedFeedbackIds: string[] },
    existingEmbedding?: number[],
  ): Promise<FeedbackRetrievalResult>
}
```

**Contract**:
- Embeds `queryText` via `EmbeddingService.embed()` (BGE-M3, ~10ms) — **skipped if `existingEmbedding` is provided** (RAG already embedded the same query text; saves 1 TEI round-trip, review F7).
- pgvector cosine search: `1 - (context_embedding <=> query_embedding) >= FEEDBACK_SIMILARITY_THRESHOLD` (default 0.75)
- Filters: `status = 'active'`, `personaId` match, `tenantId` match (RLS), NOT IN `appliedFeedbackIds`
- Scores: similarity × `weight` (which includes operator_role × recency decay)
- Returns top-K (`FEEDBACK_TOP_K`, default 3) by score
- Graceful degradation (FR-008): embedding service down / DB error → return empty array + log warning. Reply proceeds without feedback.
- Empty set (FR-009): if no `status: active` memories exist → skip embedding call + skip vector search (zero-cost no-op).

### PromptComposer

```typescript
class PromptComposer {
  compose(params: {
    personaPrompt: string;
    personaTraits?: string;
    feedbackMemories: FeedbackMemory[];
    ragChunks: GroundingContext[];
    feedbackTokenBudget: number;
    systemPromptBudget: number;
  }): ComposedPrompt
}
```

**Contract**:
- Allocates budget per layer (persona hard floor, feedback cap, RAG remainder)
- Orders layers: persona → conflict directive → RAG → feedback → (funnel appended by caller)
- Truncates feedback memories > 170 tokens
- Returns `ComposedPrompt` with token info per layer + retrieved memories

---

## 4. Dedup Reset Contract

### Reset Triggers (FR-006)

| Trigger | Condition | Action |
|---------|-----------|--------|
| Funnel stage transition (003) | `funnelResult.metadata.stage_transition.from !== stage_transition.to` | Reset `appliedFeedbackIds = []`, `messageCount = 0`. Update `lastStageLabel`. |
| N-message fallback (non-funnel) | `messageCount >= FEEDBACK_DEDUP_RESET_MESSAGES` (default 3) | Reset `appliedFeedbackIds = []`, `messageCount = 0`. |

### State Update Flow

```
1. Before reply: read conversation_feedback_states (or create if not exists)
2. Retrieve feedback (excluding appliedFeedbackIds)
3. After reply: append newly applied memory IDs to appliedFeedbackIds
4. Increment messageCount
5. Check reset triggers → if triggered, reset arrays
6. Persist updated state (optimistic locking via updatedAt)
```

---

## 5. Env Var Requirements

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `TWIN_INTERNAL_WEBHOOK_SECRET` | YES (shared with 018) | — | Auth for `GET /v1/internal/retrieved-feedback` route. |
| `FEEDBACK_DEDUP_RESET_MESSAGES` | NO | `3` | N-message fallback dedup reset for non-funnel conversations. |
| `FEEDBACK_SIMILARITY_THRESHOLD` | NO | `0.75` | Minimum cosine similarity for feedback memory retrieval. |
| `FEEDBACK_TOP_K` | NO | `3` | Max feedback memories retrieved per reply. |
| `SYSTEM_PROMPT_BUDGET_DEFAULT` | NO | `4000` | Default total system prompt budget if persona doesn't specify. |

---

## 6. Error Model

| Error | Where | Handling |
|-------|-------|----------|
| Embedding service (TEI) down | `FeedbackRetrievalService.retrieveRelevant()` | Return empty array. Log warning. RAG also degrades (same TEI). Reply proceeds with persona-only prompt. |
| pgvector search error | `FeedbackRetrievalService.retrieveRelevant()` | Return empty array. Log error. Reply proceeds without feedback. |
| conversation_feedback_states write conflict | Dedup state update | Retry once (optimistic locking). If still fails → log + proceed (dedup window may be slightly stale). |
| retrieved-feedback route auth fail | `retrieved-feedback.ts` route | `401 Unauthorized`. |
| Conversation not found | `retrieved-feedback.ts` route | `404 Not Found`. |
| Token budget overflow | `PromptComposer.compose()` | Truncate feedback memories first, then RAG chunks. Persona has hard floor (never below 500). Log truncation. |
