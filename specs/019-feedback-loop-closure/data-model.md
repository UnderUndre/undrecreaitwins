# Data Model: 019 Feedback Loop Closure

## Overview

Three storage changes: NEW `feedback_memories` table (vector + metadata — does NOT exist despite spec claiming dependency on 017), NEW `conversation_feedback_states` table (dedup tracking), MODIFY `personas` (config fields).

## New Table: `feedback_memories`

**⚠️ This table does NOT exist.** Spec 019 claims dependency on "017-hybrid-agent-core — all built, needs wiring." Incorrect: spec 017 is `language-guard-validator`. No `feedback_memories` in code or migrations (0000–0010). Created here.

```typescript
// packages/core/src/models/feedback-memories.ts

import { pgTable, uuid, text, real, timestamp, pgEnum, index } from 'drizzle-orm';
import { personas } from './personas';
import { conversations } from './conversations';
import { vector } from './types';

export const feedbackStatusEnum = pgEnum('feedback_status', ['pending', 'active']);

export const feedbackMemories = pgTable('feedback_memories', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: text('tenant_id').notNull(),
  personaId: text('persona_id').notNull().references(() => personas.id, { onDelete: 'cascade' }),
  contextEmbedding: vector('context_embedding', 1024).notNull(),  // BGE-M3 1024-dim
  lesson: text('lesson').notNull(),                                // LLM-distilled correction text
  status: feedbackStatusEnum('status').notNull().default('pending'),
  operatorRole: text('operator_role'),                             // e.g., 'sales_manager', 'qa'
  weight: real('weight').default(1.0),                             // operator_role × recency decay multiplier
  sourceConversationId: uuid('source_conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // HNSW index for cosine vector search
  // CREATE INDEX ... USING hnsw (context_embedding vector_cosine_ops)
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
| `status` | ENUM('pending','active') | Approval gate. Only `active` memories are retrieved (SC-004). `pending` = submitted but not yet approved. |
| `operatorRole` | TEXT (nullable) | Role of the submitter (e.g., 'sales_manager'). Affects weight. |
| `weight` | REAL | Composite: `operatorRole` base × recency decay. Higher = more likely to be retrieved. |
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
  status: 'pending' | 'active';
  operatorRole: string | null;
  weight: number;
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
-- feedback_memories table
CREATE TABLE feedback_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  context_embedding VECTOR(1024) NOT NULL,
  lesson TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  operator_role TEXT,
  weight REAL DEFAULT 1.0,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
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
