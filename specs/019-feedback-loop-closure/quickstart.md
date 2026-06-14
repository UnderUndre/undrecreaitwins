# Quickstart: 019 Feedback Loop Closure

## Prerequisites

1. Engine running (`packages/api` on port 8090)
2. TEI sidecar running (BGE-M3 embeddings, `EMBEDDINGS_URL=http://localhost:8080`)
3. Postgres + pgvector extension
4. Migration `0011_feedback_memories.sql` applied (creates `feedback_memories` + `conversation_feedback_states` + persona columns)
5. Env vars:
   ```bash
   TWIN_INTERNAL_WEBHOOK_SECRET=<shared-secret>   # shared with 018
   FEEDBACK_DEDUP_RESET_MESSAGES=3                # optional
   FEEDBACK_SIMILARITY_THRESHOLD=0.75             # optional
   FEEDBACK_TOP_K=3                               # optional
   ```

## Seed Test Data

Insert a feedback memory directly (since ingestion write path is a future spec):

```sql
-- Embed the context text first via TEI, then insert with the embedding
INSERT INTO feedback_memories (id, tenant_id, persona_id, context_embedding, lesson, status, operator_role, weight)
VALUES (
  gen_random_uuid(),
  '<tenant-uuid>',
  '<persona-uuid>',
  '<1024-dim-vector-from-tei>'::vector,
  'Не используй ''Уважаемый клиент'' — обращайся по имени или дружелюбно',
  'active',
  'sales_manager',
  1.5
);
```

## Validation Scenarios

### Scenario 1: Operator correction improves next reply (US1)

1. Seed a feedback memory (above) with lesson "Не используй 'Уважаемый клиент'".
2. Send a message that would normally trigger the old behavior:
   ```
   POST /v1/chat/completions
   { "model": "<persona-slug>", "messages": [{"role":"user","content":"здравствуйте"}] }
   ```
3. **Verify**:
   - Generated reply uses the customer's name or a friendly greeting (NOT "Уважаемый клиент")
   - Langfuse trace shows `feedback_memories_retrieved` span with the memory ID + similarity score
   - `GET /v1/internal/retrieved-feedback?conversationId=<id>` returns the applied memory

### Scenario 2: Pending memories are NOT retrieved (US1 acceptance 2)

1. Seed a memory with `status = 'pending'`.
2. Send a message matching the context.
3. **Verify**:
   - Memory NOT in Langfuse trace
   - Memory NOT in `/v1/internal/retrieved-feedback` response
   - Reply generated without the correction

### Scenario 3: Budget enforcement (US2)

1. Configure a persona with `feedback_token_budget = 200` (tight budget).
2. Seed 5 active feedback memories with long lessons (each > 170 tokens).
3. Send a message matching all.
4. **Verify**:
   - Only 1 feedback memory included (200 / 170 ≈ 1.17)
   - Langfuse trace shows token allocation per layer
   - Persona prompt NOT truncated (hard floor 500)

### Scenario 4: Dedup prevents fatigue (US3)

1. Seed 1 active feedback memory.
2. Send 3 messages that match the memory context.
3. **Verify**:
   - Message 1: memory applied (in trace)
   - Messages 2-3: memory NOT applied (in `appliedFeedbackIds`, dedup active)
4. Trigger a stage transition (or send 4th message for non-funnel).
5. **Verify**: memory re-applied (dedup reset).

### Scenario 5: Graceful degradation (TEI down)

1. Stop the TEI sidecar.
2. Send a message.
3. **Verify**:
   - Reply generated successfully (without feedback)
   - Engine logs warning: "Embedding service unavailable, feedback retrieval skipped"
   - RAG also degraded (same TEI)
   - Persona-only prompt used

### Scenario 6: Empty feedback set (no-op)

1. Ensure persona has 0 active feedback memories.
2. Send a message.
3. **Verify**:
   - No embedding call made (zero-cost no-op, FR-009)
   - No vector search
   - Reply generated with persona + RAG only
