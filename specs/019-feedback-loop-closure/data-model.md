# Data Model: 019 Feedback Loop Closure

## Overview

Three storage changes: NEW `feedback_memories` table (vector + metadata — designed in ai-twins spec 017-hybrid-agent-core Phase 2 but NOT yet implemented), NEW `conversation_feedback_states` table (dedup tracking), MODIFY `personas` (config fields).

**Cross-repo alignment**: The `feedback_memories` table schema is defined in `ai-twins/specs/017-hybrid-agent-core/data-model.md` (Phase 2, lines 101-134). This plan implements it in the Engine Drizzle layer, aligned with the 017 design. Key schema notes from 017: `status` has **3 values** (`pending`/`active`/`archived` — archived for cap-200 rotation, not just 2); 017 uses `assistant_id` column name (Product naming) but Engine tables use `persona_id` — this plan uses `persona_id` for Engine consistency.

## New Table: `feedback_memories`

**⚠️ This table is designed in ai-twins spec 017-hybrid-agent-core (Phase 2, data-model.md:101-134) but NOT implemented.** No migration, no Prisma model, no code. Created here, aligned with 017 design.

```typescript
// packages/core/src/models/feedback-memories.ts

import { pgTable, uuid, text, real, timestamp, pgEnum, index } from 'drizzle-orm';
import { personas } from './personas';
import { conversations } from './conversations';
import { vector } from './types';

// 3 values per 017 data-model.md:122 — 'archived' for cap-200 rotation (old memories archived, not deleted)
export const feedbackStatusEnum = pgEnum('feedback_status', ['pending', 'active', 'archived']);

export const feedbackMemories = pgTable('feedback_memories', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: text('tenant_id').notNull(),
  personaId: text('persona_id').notNull().references(() => personas.id, { onDelete: 'cascade' }),  // 017 uses 'assistant_id'; Engine uses 'persona_id' (same entity)
  contextEmbedding: vector('context_embedding', 1024).notNull(),  // BGE-M3 1024-dim (NOT NULL per 017 final)
  lesson: text('lesson').notNull(),                                // LLM-distilled correction text
  status: feedbackStatusEnum('status').notNull().default('pending'),
  operatorRole: text('operator_role'),                             // CHECK IN ('owner','admin','member') per 017
  weight: real('weight').default(1.0),                             // operator_role × recency decay multiplier
  sourceConversationId: uuid('source_conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  // Additional columns from 017 design (Phase 2):
  userQuery: text('user_query'),                                   // original user message that triggered correction
  wrongResponse: text('wrong_response'),                           // the bad assistant reply (nullable)
  correctedResponse: text('corrected_response'),                   // operator's corrected version (nullable)
  feedbackType: text('feedback_type'),                             // e.g., 'tone', 'factual', 'style'
  errorCategory: text('error_category'),                           // e.g., 'false_promise', 'off_topic'
  operatorId: text('operator_id'),                                 // FK → users (who submitted)
  embeddingModel: text('embedding_model').default('bge-m3'),       // model used for context_embedding
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantPersonaStatusIdx: index('feedback_memories_tenant_persona_status_idx')
    .on(table.tenantId, table.personaId, table.status),
}));
```

**HNSW index** (in migration SQL):
```sql
CREATE INDEX feedback_memories_context_embedding_hnsw_idx
  ON feedback_memories USING hnsw (context_embedding vector_cosine_ops);
```

**Field notes**:

| Field | Type | Purpose |
|-------|------|---------|
| `contextEmbedding` | vector(1024) | BGE-M3 embedding of the context that triggered the correction. Cosine-searched at retrieval time. |
| `lesson` | TEXT | LLM-distilled operator correction (e.g., "Не используй 'Уважаемый клиент' — обращайся по имени"). Injected into prompt. |
| `status` | ENUM('pending','active','archived') | Approval gate + cap-200 rotation. Only `active` memories are retrieved (SC-004). `pending` = submitted but not approved. `archived` = old memories rotated out (cap-200, per 017 data-model.md:134). |
| `operatorRole` | TEXT (nullable) | Role of the submitter (e.g., 'sales_manager'). Affects weight. |
| `weight` | REAL | **Static base weight** = `operator_role` multiplier (e.g., owner=1.5, admin=1.2, member=1.0). Written once at creation. **Recency decay is NOT stored** — computed at query time from `createdAt`: `decay = exp(-age_days / 30)`. Composite retrieval score = `cosine_similarity × weight × decay`. (review F3) |
| `sourceConversationId` | UUID (nullable, FK) | Conversation that generated this feedback. For traceability. |

## New Table: `conversation_feedback_states`

Dedup tracking for feedback memories applied per conversation. Separate from `conversation_funnel_states` (which only exists for funnel conversations — feedback dedup applies to ALL conversations per spec FR-006).

```typescript
// packages/core/src/models/conversation-feedback-states.ts

import { pgTable, uuid, jsonb, integer, timestamp } from 'drizzle-orm';
import { conversations } from './conversations';

export const conversationFeedbackStates = pgTable('conversation_feedback_states', {
  conversationId: uuid('conversation_id').primaryKey().references(() => conversations.id, { onDelete: 'cascade' }),
  appliedFeedbackIds: jsonb('applied_feedback_ids').notNull().$type<string[]>().default([]),
  messageCount: integer('message_count').notNull().default(0),
  lastStageLabel: text('last_stage_label'),                         // for funnel stage transition detection
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

**Field notes**:

| Field | Type | Purpose |
|-------|------|---------|
| `appliedFeedbackIds` | JSONB (string[]) | Memory IDs already injected in the current stage. Excluded from retrieval (dedup, FR-002). Reset on stage transition (FR-006). |
| `messageCount` | INT | Messages since last reset. Non-funnel conversations reset every N messages (env `FEEDBACK_DEDUP_RESET_MESSAGES`, default 3). |
| `lastStageLabel` | TEXT (nullable) | Funnel stage label from 003. If current stage differs → reset `appliedFeedbackIds` + `messageCount`. Null for non-funnel conversations. |

## Modified: `personas`

Add two config columns for per-persona feedback retrieval control (FR-007):

```sql
ALTER TABLE personas
  ADD COLUMN feedback_retrieval_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN feedback_token_budget integer NOT NULL DEFAULT 500;
```

```typescript
// In personas.ts, after ragMode field:
feedbackRetrievalEnabled: boolean('feedback_retrieval_enabled').notNull().default(true),
feedbackTokenBudget: integer('feedback_token_budget').notNull().default(500),
```

## Types (Service Layer)

```typescript
// packages/core/src/services/feedback/types.ts

interface FeedbackMemory {
  id: string;
  tenantId: string;
  personaId: string;
  contextEmbedding: number[];    // not sent to LLM — used only for retrieval
  lesson: string;
  status: 'pending' | 'active' | 'archived';
  operatorRole: string | null;
  weight: number;                  // STATIC base weight (operator_role multiplier). Recency decay computed at query time from createdAt — NOT stored.
  createdAt: Date;
}

interface ComposedPrompt {
  systemPrompt: string;
  layers: {
    persona: TokenInfo;
    feedback: TokenInfo;
    rag: TokenInfo;
  };
  retrievedMemories: FeedbackMemory[];
  totalTokens: number;
}

interface TokenInfo {
  tokens: number;
  truncated: boolean;
  itemsIncluded: number;
}

interface FeedbackRetrievalResult {
  memories: FeedbackMemory[];
  similarityScores: Array<{ memoryId: string; score: number }>;
  latencyMs: number;
}
```

## Relationship to Existing Models

| Existing Model | 019 Relationship |
|----------------|------------------|
| `personas` | Extended with `feedbackRetrievalEnabled` + `feedbackTokenBudget`. Feedback memories are scoped by `personaId`. |
| `conversations` | `conversation_feedback_states` tracks dedup per conversation. `feedback_memories.sourceConversationId` links to origin. |
| `conversation_funnel_states` | Stage label from funnel state drives dedup reset. `lastStageLabel` in `conversation_feedback_states` mirrors the funnel stage for transition detection. |
| `annotations` | Similar pattern (vector + tenantId + personaId). Annotations are few-shot examples; feedback memories are operator corrections. No overlap. |
| `document_chunks` | RAG context. Prompt composer allocates budget alongside RAG chunks. |

## Migration SQL

File: `drizzle/0011_feedback_memories.sql` (review-only per Standing Order #5)

```sql
-- feedback_memories table (aligned with ai-twins 017-hybrid-agent-core Phase 2 design)
CREATE TABLE feedback_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  context_embedding VECTOR(1024) NOT NULL,
  lesson TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'archived')),
  operator_role TEXT CHECK (operator_role IN ('owner', 'admin', 'member')),
  weight REAL DEFAULT 1.0,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  user_query TEXT,
  wrong_response TEXT,
  corrected_response TEXT,
  feedback_type TEXT,
  error_category TEXT,
  operator_id TEXT,
  embedding_model TEXT DEFAULT 'bge-m3',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for cosine vector search
CREATE INDEX feedback_memories_context_embedding_hnsw_idx
  ON feedback_memories USING hnsw (context_embedding vector_cosine_ops);

-- Filtered retrieval index
CREATE INDEX feedback_memories_tenant_persona_status_idx
  ON feedback_memories (tenant_id, persona_id, status);

-- conversation_feedback_states table
CREATE TABLE conversation_feedback_states (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  applied_feedback_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_stage_label TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Persona config extension
ALTER TABLE personas
  ADD COLUMN feedback_retrieval_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN feedback_token_budget INTEGER NOT NULL DEFAULT 500;

-- Enable RLS on new tables
ALTER TABLE feedback_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_feedback_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY feedback_memories_tenant_isolation ON feedback_memories
  USING (tenant_id = current_setting('app.current_tenant', true));

CREATE POLICY conversation_feedback_states_tenant_isolation ON conversation_feedback_states
  USING (EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = conversation_feedback_states.conversation_id
    AND c.tenant_id = current_setting('app.current_tenant', true)
  ));
```
