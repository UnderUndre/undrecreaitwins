# Research: Engine Tuning Pipeline Design

**Phase 0** — Pipeline design exploration, LLM prompt format, existing service integration points.

## 1. Existing Service Integration Points

### 1.1 Document Chunks (RAG Input for Method A)

- **Table**: `document_chunks` (spec 005) — pgvector-enabled, linked to `documents` via `document_id`
- **Query**: `SELECT * FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE persona_id = :personaId) ORDER BY chunk_index`
- **Reuse**: 100% — no new schema needed for reading chunks
- **Consideration**: Chunks may be large (up to 512 tokens each). For extraction, we need the full text content, not just vectors. The `content` column stores the raw text.

### 1.2 Chat Pipeline (Sandbox Preview)

- **Service**: `ChatService` in `packages/core/src/services/chat-service.ts`
- **Method**: `complete()` is the public entrypoint (line 168). `buildSystemPrompt()` is private (line 1108).
- **Override mechanism**: Inject draft `systemPrompt` + `funnelConfig` + `validatorToggles` into the pipeline without mutating the live persona.
- **Approach**: **Shadow persona object** — construct a shallow copy of the persona row with draft fields overlaid, then pass it through the existing `ChatService.complete()` public API. No private-method patching. The `ChatRequest` type gains an optional `draftOverride?: DraftConfigOverlay` field; `ChatService.complete()` checks for override after loading persona from DB and replaces the corresponding fields before passing to funnel runtime + validator pipeline. This is additive (non-breaking) and threads the overlay through all sub-pipelines.

### 1.3 Persona CRUD (Activate/Rollback)

- **Repository**: `PersonaRepository` in `packages/core/src/services/persona-repository.ts`
- **Key methods**: `getById()`, `update()` — both tenant-scoped via `withTenantContext`
- **Atomicity**: `update()` opens its own `withTenantContext` transaction. For atomic activate (FR-006), `PersonaRepository.update()` MUST be refactored to accept an injected `tx` parameter so the caller controls the transaction boundary. Alternatively, activate uses raw drizzle queries inside a single `withTenantContext` instead of calling the repository.
- **Fields to update on activate**: `system_prompt`, `traits` (JSONB)
- **Snapshot**: Read current persona config (systemPrompt, traits) + prior funnel active-version id + prior validator toggles before update, store as `previousSnapshot` JSONB in the draft.

### 1.4 Funnel CRUD (Activate)

- **Repository**: `FunnelRepository` in `packages/core/src/services/funnel/funnel-repository.ts`
- **Real API**: `createVersion(definitionId, config, stages[], slots[])` (line 153) — requires a pre-existing `funnelDefinition` (via `createFunnel()`/`getActiveVersion()`). Each stage requires `fragments[]` (text content for delivery).
- **Reuse**: **EXTEND, not 100% reuse.** The draft's flat `funnelConfig` JSONB and the LLM's `funnelStages: [{name, description, triggers, slots[]}]` (data-model §5) must be **decomposed** into `stages` + `slots[]` arrays. A `fragments[]` array must be synthesized for each stage (default: use the stage `description` as the fragment text). A definition must be resolved or created first (`createFunnel()` if persona has no funnel, `getActiveVersion()` + `createVersion()` if upgrading).
- **New task needed**: `funnelConfig → {definition, stages[], fragments[], slots[]}` mapper service.
- **Atomicity**: Like PersonaRepository, `createVersion` opens its own transaction. For atomic activate, it MUST accept an injected `tx`.

### 1.5 Validator Pipeline (Quality Gate)

- **Service**: Validator pipeline in `packages/core/src/services/validators/pipeline.ts`
- **Real API**: `validateResponse(reply, context)` and `validateInput(input, context)`. "dry-run" is a *per-validator mode* read from `validator_configs` (line 95,98), NOT a callable method. `validateResponse` requires a `conversationId` and persists to `validator_runs` — at generation time there is no conversation.
- **Reuse**: **NOT available for v1 quality gate.** Validators judge a *generated reply*, not a *systemPrompt*. Computing a block-rate requires generating sample replies first.
- **v1 approach**: Drop validator-based quality gate. Use LLM self-reported `confidence` from the extraction output (data-model §5). Validator-based gating deferred to v1.1 (requires probe-message set + synthetic conversation context).

### 1.6 LLM Client (Extraction + Interview + Self-Tuner)

- **Service**: `LLMClient` in `packages/core/src/services/llm-client.ts`
- **Real API**: `complete(params: LLMRequest)` sends `{ model, messages, temperature, max_tokens }` (line 65-70). The `LLMRequest` interface (line 14-20) has **no `response_format` field**.
- **Reuse**: **EXTEND, not 100% reuse.** Add `responseFormat?: { type: 'json_object' }` to `LLMRequest` interface and pass it through in the fetch body (line 65). This is a 2-line additive change but MUST be done before extraction pipeline works.
- **New task needed**: Extend `LLMClient` to support `response_format` passthrough.

## 2. Extraction Prompt Design

### 2.1 Prompt Structure

The extraction prompt instructs the LLM to analyze document chunks and produce structured configuration:

```
System: You are a configuration extraction expert. Analyze the provided document chunks
for a digital twin persona and extract the optimal configuration.

User: Analyze these document chunks about the persona's business, products, and communication style.
Return a JSON object with:
- systemPrompt: A detailed system prompt for the AI twin (2-3 paragraphs)
- funnelStages: Array of { name, description, triggers, slots[] } for the sales funnel
- validatorToggles: Object with validator names as keys and boolean values
- confidence: "high" | "medium" | "low"

Document chunks:
[chunk 1 content]
[chunk 2 content]
...
```

### 2.2 Fallback Strategy

If LLM returns unparseable JSON:

1. Attempt to extract `systemPrompt` via regex (look for `"systemPrompt"` key)
2. If that fails, use the raw text as `systemPrompt` with `funnelConfig=null`, `confidence='low'`
3. Mark draft as `ready` with `confidence='low'` — Product shows warning

### 2.3 Timeout Handling

- LLM call wrapped in `AbortController` with 55s timeout (leaving 5s for DB writes before 60s SC-001)
- On timeout: draft status → `failed`, `error: 'LLM_TIMEOUT'`

## 3. Interview State Machine Design

### 3.1 Question Bank

7 questions covering:

1. `q1`: "Что вы продаёте?" (What do you sell?)
2. `q2`: "Кто ваша целевая аудитория?" (Who is your target audience?)
3. `q3`: "Какие возражения чаще всего встречаются?" (What objections do you face?)
4. `q4`: "Какой стиль общения предпочитаете?" (What communication style?)
5. `q5`: "Какие этапы продаж у вас есть?" (What sales stages?)
6. `q6`: "Какие документы/материалы у вас есть?" (What reference materials?)
7. `q7`: "Какие KPI важны?" (What KPIs matter?)

### 3.2 Adaptive Skipping

- After each answer, check if persona has document chunks
- If answer content is already covered by existing docs, skip the question
- Track skipped questions in session state

### 3.3 Draft Generation

When all questions answered (or skipped):

1. Compile answers into a structured prompt
2. Call LLM with same extraction prompt format as Method A
3. Create draft with `method: 'interview'`
4. Return `{ draftId, status: 'ready' }` from the `next` endpoint

## 4. Self-Tuner Conversation Analysis

### 4.1 Pattern Detection

Analyze recent conversations (last N, configurable, default 20):

- **Repeated topics**: TF-IDF or simple frequency analysis on user messages
- **Failed validations**: Query `validator_runs` for recent failures per persona
- **Block-rate spikes**: Compare recent block-rate to rolling average
- **Sentiment shifts**: Basic sentiment analysis on user messages

### 4.2 Proposal Format

```typescript
interface TuningProposal {
  id: string;           // UUID, stable for 30min cache
  personaId: string;
  signal: 'repeated_topic' | 'validation_failures' | 'block_rate_spike' | 'sentiment_shift';
  description: string;  // Human-readable description
  riskLevel: 'low' | 'medium' | 'high';
  affectedConversations: number;  // Count of conversations with this pattern
  suggestedAction: string;  // What the draft would change
  createdAt: string;    // ISO timestamp
}
```

### 4.3 Warm-up Threshold

- <20 conversations → return empty `proposals` array + `{ warmup: { conversationsNeeded: 20 - current, currentCount } }`
- ≥20 conversations → run analysis, return proposals

## 5. Redis Cache Key Design

### 5.1 Interview Sessions

```
Key: `tuning:interview:{tenantId}:{personaId}`
Value: JSON { currentQuestion, answers[], total, createdAt }
TTL: 1800 (30 min)
```

### 5.2 Proposals Cache

```
Key: `tuning:proposals:{tenantId}:{personaId}`
Value: JSON { proposals: TuningProposal[], generatedAt }
TTL: 1800 (30 min)
```

### 5.3 Proposal Resolution (accept/reject)

```
Key: `tuning:proposal:{proposalId}`
Value: JSON TuningProposal
TTL: 1800 (30 min) — same as parent cache
```

## 6. Poll-Time Reaper Logic

```typescript
async function getDraftWithReaper(draftId: string, tenantId: string): Promise<TuningDraft> {
  const draft = await draftRepo.getById(draftId, tenantId);
  if (draft.status === 'generating' && Date.now() - draft.createdAt.getTime() > 90_000) {
    draft.status = 'failed';
    draft.error = 'GENERATION_STALLED';
    await draftRepo.update(draft);
  }
  return draft;
}
```

## 7. In-Process Background Task Pattern

For v1, generation runs in-process (fire-and-forget after 202 response):

```typescript
// In route handler:
const draft = await draftRepo.create({ status: 'generating', ... });
// Don't await — fire and forget WITH crash safety
process.nextTick(() => {
  runGenerationPipeline(draft.id, tenantId)
    .catch(err => {
      // Prevent unhandled rejection → process crash
      markDraftFailed(draft.id, tenantId, err).catch(() => {
        console.error(`[tuning] Failed to mark draft ${draft.id} as failed:`, err);
      });
    });
});
return { draftId: draft.id, status: 'generating' };
```

The `runGenerationPipeline` function:

1. **MUST** wrap all DB writes in `withTenantContext(tenantId, ...)` — the request transaction is gone after 202; RLS blocks unscoped writes
2. Reads document chunks (with chunk selection: top-K by relevance, max 8K tokens)
3. Calls LLM with extraction prompt (`response_format: { type: 'json_object' }`)
4. Parses response
5. Maps `funnelConfig` → `{definition, stages[], fragments[], slots[]}` via funnel mapper
6. Updates draft status to `ready` or `failed`

**Startup sweep** (covers process restarts where nobody polls):

```typescript
// On Fastify onReady:
fastify.addHook('onReady', async () => {
  await withTenantContext('system', async (tx) => {
    await tx.update(tuningDrafts)
      .set({ status: 'failed', error: 'GENERATION_STALLED' })
      .where(and(
        eq(tuningDrafts.status, 'generating'),
        lt(tuningDrafts.createdAt, new Date(Date.now() - 5 * 60 * 1000))
      ));
  });
});
```

**Stale-draft escape in generate** (FR-011): before lock check, sweep stale drafts for this persona:

```typescript
// In generate handler, before concurrent-lock check:
await draftRepo.sweepStaleGenerating(personaId, tenantId, 90_000); // 90s threshold
```

This prevents a permanently-bricked persona if the client stops polling after the tab is closed.
