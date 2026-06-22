# Data Model: Engine Tuning

## 1. `tuning_drafts` Table (Drizzle Schema)

### 1.1 Columns

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `uuid` | PK, default `gen_random_uuid()` | Draft unique identifier |
| `tenant_id` | `text` | NOT NULL | Tenant isolation (RLS key) |
| `persona_id` | `text` | NOT NULL, FK → `personas.id` | Target persona |
| `method` | `text` (enum) | NOT NULL | `doc-extraction` \| `template-bootstrap` \| `interview` \| `self-tuner` |
| `status` | `text` (enum) | NOT NULL, default `'generating'` | `generating` \| `ready` \| `failed` \| `activated` \| `superseded` \| `rolled-back` |
| `confidence` | `text` (enum) | nullable | `high` \| `medium` \| `low` |
| `system_prompt` | `text` | nullable | Extracted/configured system prompt |
| `funnel_config` | `jsonb` | nullable | Funnel stages configuration |
| `validator_toggles` | `jsonb` | nullable | Validator enable/disable map |
| `diff_sections` | `jsonb` | nullable | Diff between previous and new config |
| `previous_snapshot` | `jsonb` | nullable | Snapshot of persona config before activation |
| `signals` | `jsonb` | nullable | Proposal signals (for self-tuner method) |
| `error` | `text` | nullable | Error message if status=failed |
| `review_verdict` | `text` (enum) | nullable | `approved` \| `rejected` (advisory, not gate) |
| `review_notes` | `text` | nullable | Optional review notes |
| `created_at` | `timestamptz` | NOT NULL, default `now()` | Creation timestamp |
| `updated_at` | `timestamptz` | NOT NULL, default `now()` | Last update timestamp |
| `activated_at` | `timestamptz` | nullable | Activation timestamp |

### 1.2 Indexes

```sql
CREATE INDEX idx_tuning_drafts_persona_status ON tuning_drafts (persona_id, status);
CREATE INDEX idx_tuning_drafts_tenant_status ON tuning_drafts (tenant_id, status);
CREATE INDEX idx_tuning_drafts_created_at ON tuning_drafts (created_at DESC);
```

### 1.3 RLS Policy

```sql
ALTER TABLE tuning_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tuning_drafts
  USING (tenant_id = current_setting('app.current_tenant')::text);
```

### 1.4 Drizzle Schema Definition

```typescript
import { pgTable, text, uuid, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const tuningDrafts = pgTable('tuning_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: text('tenant_id').notNull(),
  personaId: text('persona_id').notNull(),
  method: text('method', { enum: ['doc-extraction', 'template-bootstrap', 'interview', 'self-tuner'] }).notNull(),
  status: text('status', { enum: ['generating', 'ready', 'failed', 'activated', 'superseded', 'rolled-back'] }).notNull().default('generating'),
  confidence: text('confidence', { enum: ['high', 'medium', 'low'] }),
  systemPrompt: text('system_prompt'),
  funnelConfig: jsonb('funnel_config'),
  validatorToggles: jsonb('validator_toggles'),
  diffSections: jsonb('diff_sections'),
  previousSnapshot: jsonb('previous_snapshot'),
  signals: jsonb('signals'),
  error: text('error'),
  reviewVerdict: text('review_verdict', { enum: ['approved', 'rejected'] }),
  reviewNotes: text('review_notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
});
```

## 2. Interview Session (Redis, ephemeral)

### 2.1 Shape

```typescript
interface InterviewSession {
  personaId: string;
  currentQuestion: number;     // Index into question bank (0-based)
  answers: Array<{
    questionId: string;
    question: string;
    answer: string;
    skipped: boolean;
  }>;
  total: number;               // Total questions (7)
  skipped: string[];           // questionIds that were skipped
  createdAt: number;           // Unix timestamp ms
}
```

### 2.2 Redis Key

```
tuning:interview:{tenantId}:{personaId}
```

TTL: 1800s (30 min)

## 3. Tuning Proposal (Redis cache, ephemeral)

### 3.1 Shape

```typescript
interface TuningProposal {
  id: string;                       // UUID
  personaId: string;
  signal: 'repeated_topic' | 'validation_failures' | 'block_rate_spike' | 'sentiment_shift';
  description: string;
  riskLevel: 'low' | 'medium' | 'high';
  affectedConversations: number;
  suggestedAction: string;
  createdAt: string;                // ISO 8601
}
```

### 3.2 Redis Keys

```
tuning:proposals:{tenantId}:{personaId}    // Proposal set (TTL 1800s)
tuning:proposal:{proposalId}               // Individual proposal (TTL 1800s)
```

## 4. Configuration Overlay (Sandbox Preview)

```typescript
interface DraftConfigOverlay {
  systemPrompt?: string;
  funnelConfig?: FunnelConfig;
  validatorToggles?: Record<string, boolean>;
}
```

This overlay is passed to `ChatService.buildSystemPrompt()` and the funnel/validator pipelines. It shadows live persona config fields without mutation.

## 5. LLM Structured Output Schema

```typescript
interface ExtractionOutput {
  systemPrompt: string;
  funnelStages: Array<{
    name: string;
    description: string;
    triggers: string[];
    slots: Array<{ name: string; type: string; question: string }>;
  }>;
  validatorToggles: Record<string, boolean>;
  confidence: 'high' | 'medium' | 'low';
}
