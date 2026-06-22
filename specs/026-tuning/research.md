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
- **Method**: `buildSystemPrompt()` → `complete()` (or streaming variant)
- **Override mechanism**: Need to inject draft `systemPrompt` + `funnelConfig` + `validatorToggles` into the pipeline without mutating the live persona
- **Approach**: Create a `DraftConfigOverlay` object that wraps the live persona config and shadows specific fields. Pass to `ChatService` as an optional parameter.

### 1.3 Persona CRUD (Activate/Rollback)

- **Repository**: `PersonaRepository` in `packages/core/src/services/persona-repository.ts`
- **Key methods**: `getPersonaById()`, `updatePersona()` — both tenant-scoped
- **Fields to update on activate**: `system_prompt`, `traits` (JSONB)
- **Snapshot**: Read current persona config before update, store as `previousSnapshot` JSONB in the draft

### 1.4 Funnel CRUD (Activate)

- **Repository**: `FunnelRepository` in `packages/core/src/services/funnel/funnel-repository.ts`
- **Key method**: `createFunnelVersion(personaId, funnelConfig)` — creates a new version entry
- **Reuse**: 100% — funnel config from draft is passed directly

### 1.5 Validator Pipeline (Quality Gate)

- **Service**: Validator pipeline in `packages/core/src/services/validators/pipeline.ts`
- **Method**: `runDryRun(systemPrompt, messages)` — runs validators without affecting live state
- **Reuse**: 90% — dry-run mode exists, may need minor extension for tuning-specific metrics

### 1.6 LLM Client (Extraction + Interview + Self-Tuner)

- **Service**: `LLMClient` in `packages/core/src/services/llm-client.ts`
- **Key method**: `complete(messages, options?)` — supports `response_format: { type: 'json_object' }` for OpenAI-compatible providers
- **Extension needed**: Structured output parsing with fallback for unparseable JSON

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
// Don't await — fire and forget
process.nextTick(() => runGenerationPipeline(draft.id, tenantId));
return { draftId: draft.id, status: 'generating' };
```

The `runGenerationPipeline` function:

1. Reads document chunks
2. Calls LLM with extraction prompt
3. Parses response
4. Updates draft status to `ready` or `failed`
5. Runs validator dry-run for quality gate

If the process crashes during generation, the poll-time reaper (FR-003) catches it on next poll after 90s.
