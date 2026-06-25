# Quickstart: Big Context Window LLM as RAG

## Prerequisites

- Engine running locally (PostgreSQL + Redis + API)
- A persona configured with `groundingMode: 'big-context'`
- A file to test parsing/upload (e.g. PDF/DOCX)
- `X-Tenant-ID` header value for your test tenant

## Local Dev Setup

### 1. Update Database Schema

Create and apply migrations for the new columns:

```bash
pnpm db:generate
pnpm db:migrate
```

Ensure PG 14+ is used and verify `full_text` compression is set to `lz4`:
```sql
ALTER TABLE documents ALTER COLUMN full_text SET COMPRESSION lz4;
```

### 2. Start Services

```bash
# Start API
pnpm --filter @undrecreaitwins/api dev

# Start Ingestion Worker
pnpm --filter @undrecreaitwins/training dev
```

---

## Verifying User Stories

### User Story 1: Chat Grounding with Big Context

#### Step 1: Configure Persona to use `big-context`
```bash
curl -X PATCH http://localhost:3000/v1/personas/:personaId \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>" \
  -H "Content-Type: application/json" \
  -d '{"grounding_mode": "big-context", "truncation_strategy": "silent"}'
```

#### Step 2: Upload Documents
Use the standard document upload endpoint.
Raw document content will be extracted and saved to PostgreSQL `documents.full_text`.

#### Step 3: Trigger Chat Completion
```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>" \
  -H "Content-Type: application/json" \
  -d '{
    "personaId": "persona-123",
    "messages": [{"role": "user", "content": "сколько стоит худи с вышивкой 15×15?"}]
  }'
```

**Verify**:
- The prompt sent to LLM contains the full text of the uploaded documents.
- No calls are made to `/embed` or `/rerank` endpoints.
- Response contains exact pricing/data from the documents.
- Injected token counts and cost are logged via Langfuse trace.

---

### User Story 2: Doc-Extraction Tuning with Big Context

Trigger tuning via the `doc-extraction` method:

```bash
curl -X POST http://localhost:3000/v1/personas/:personaId/tuning/generate \
  -H "Authorization: Bearer <token>" \
  -H "X-Tenant-ID: <tenantId>" \
  -H "Content-Type: application/json" \
  -d '{"method": "doc-extraction"}'
```

**Verify**:
- The tuning pipeline processes the entire document text instead of retrieved chunks.
- Zero requests are sent to the embedding adapter.

---

### User Story 3: Context Budget Truncation and Fallback

#### Truncation Verify:
1. Set the persona's `big_context_max_tokens` override to a small budget (e.g., 2000).
2. Upload documents exceeding 2000 tokens (e.g. total 10K tokens). Set different priority values (e.g., Doc A priority = 10, Doc B priority = 0).
3. Send a chat query.
4. **Verify**: Doc A is included in the prompt, Doc B is truncated/dropped. No crash occurs. A warning is emitted.

#### Fallback Verify:
1. Set `truncation_strategy` to `'fallback-vector'`.
2. Upload documents exceeding the context budget.
3. Ensure background indexing completes (lazy embeddings built).
4. Send a query that exceeds the context budget.
5. **Verify**: System automatically executes vector RAG retrieval instead of big-context retrieval.

---

## Testing

```bash
# Run tests for grounding engine and documents
pnpm --filter @undrecreaitwins/core test -- --grep "grounding"
pnpm --filter @undrecreaitwins/core test -- --grep "document"
```
