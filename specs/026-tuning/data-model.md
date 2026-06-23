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
-- Partial unique index: enforces FR-011 (only one generating draft per persona)
CREATE UNIQUE INDEX idx_tuning_drafts_persona_generating ON tuning_drafts (persona_id) WHERE status = 'generating';
```

### 1.3 RLS Policy

Mirror the established engine pattern exactly (FORCE + WITH CHECK + 2-arg current_setting):

```sql
ALTER TABLE tuning_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tuning_drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tuning_drafts
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));
```

### 1.4 Drizzle Schema Definition

```typescript
import { pgTable, text, uuid, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
}, (table) => {
  return {
    idxTuningDraftsPersonaStatus: index('idx_tuning_drafts_persona_status').on(table.personaId, table.status),
    idxTuningDraftsTenantStatus: index('idx_tuning_drafts_tenant_status').on(table.tenantId, table.status),
    idxTuningDraftsCreatedAt: index('idx_tuning_drafts_created_at').on(table.createdAt.desc()),
    idxTuningDraftsPersonaGenerating: uniqueIndex('idx_tuning_drafts_persona_generating')
      .on(table.personaId)
      .where(sql`status = 'generating'`),
  };
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

Keyed per interviewer (not just per persona) to prevent concurrent admins clobbering each other:

```
tuning:interview:{tenantId}:{personaId}:{userId}
```

TTL: 1800s (30 min)

**Cursor semantics**: `answer` records the answer and advances `currentQuestion`. `next` serves the question at the current (unanswered) position without advancing. Double-`next` returns the same question.

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

Store proposals in a **single structure** (JSON array) to avoid dual-key consistency issues:

```
tuning:proposals:{tenantId}:{personaId}    // JSON array of TuningProposal (TTL 1800s)
```

On `reject`: update the cached array to remove the rejected proposal (rewrite the key).
On `accept`: remove the proposal from the cached array + create draft.
No separate per-item keys — the array is the single source of truth.

## 4. Configuration Overlay (Sandbox Preview) + Previous Snapshot Scope

### 4.1 DraftConfigOverlay (Sandbox)

```typescript
interface DraftConfigOverlay {
  systemPrompt?: string;
  funnelConfig?: FunnelConfig;
  validatorToggles?: Record<string, boolean>;
}
```

This overlay is applied via **shadow persona object**: `ChatService.complete()` loads the live persona, then replaces fields with overlay values before passing to sub-pipelines (funnel runtime, validator pipeline). No private-method patching — the overlay threads through the existing public API via an optional `draftOverride` field on `ChatRequest`.

### 4.2 PreviousSnapshot Scope (Rollback)

`previousSnapshot` captures the **full live config before activation** — not just persona prompt:

```typescript
interface PreviousSnapshot {
  // Persona
  systemPrompt: string;
  traits: Record<string, unknown>;
  // Funnel
  priorFunnelVersionId: string | null;
  // Validators
  priorValidatorToggles: Record<string, boolean>;
}
```

Rollback (FR-007) restores ALL three: persona prompt/traits, reactivates prior funnel version, restores validator toggles.

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
