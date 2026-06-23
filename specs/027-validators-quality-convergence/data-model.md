# Data Model: Validators ⊕ Quality Rules Convergence

**Feature**: 027-validators-quality-convergence  
**Date**: 2026-06-23  
**Status**: Draft

## 1. Unified Rule Model

### 1.1 Engine Representation (Rule Cache)

Engine receives unified rules from BFF via `rules-reload` push. Stored in memory (rule-cache), not persisted directly.

```typescript
// packages/core/src/types/quality.ts

export type RuleKind = 'system' | 'custom';
export type RuleMode = 'active' | 'dry-run';  // Mirrors real validator_mode enum (NOT strict/lenient)
export type VerdictCoarse = 'pass' | 'block' | 'warn' | 'corrected';
export type VerdictDetail = 
  | 'translated' 
  | 'regenerated' 
  | 'rewritten' 
  | 'rolled_back' 
  | 'stripped' 
  | 'degraded'   // Guard failure fallback (F10 fix)
  | 'skipped';   // Stage skipped due to short-circuit (F10 fix)

// Detector config mirrors CorrectionRule.detector (required for DAR to function — fix F2)
export type DetectorConfig =
  | { type: 'regex'; config: { pattern: string; flags?: string } }
  | { type: 'keyword'; config: { words: string[]; matchAll?: boolean } }
  | { type: 'pattern'; config: { description: string } }
  | { type: 'semantic'; config: { prompt: string; rubricItems?: RubricItem[] } };

export interface RubricItem {
  id: string;
  text: string;
  required: boolean;
}

export interface UnifiedRule {
  key: string;                    // Unique rule identifier (e.g., 'language-guard', 'custom-123')
  kind: RuleKind;                 // 'system' (built-in validator) or 'custom' (LLM-based)
  enabled: boolean;               // On/off switch
  mode?: RuleMode;                // 'active' | 'dry-run' (mirrors real validator_mode enum)
  terminalOnFail: boolean;        // Short-circuit flag: stop pipeline on failure
  priority: number;               // Stage execution order (lower = earlier)
  
  // System validator config (for kind='system')
  validatorType?: 'language-guard' | 'false-promise' | 'format-injection' | 'identity-guard';
  
  // Custom rule config (for kind='custom') — must carry full CorrectionRule payload (fix F2)
  detector?: DetectorConfig;      // REQUIRED for kind='custom' — DAR branches on detector.type
  rewriteInstruction?: string;    // DAR rewrite prompt
  customRuleMode?: 'rewrite' | 'score';  // DAR mode (NOT RuleMode — different axis)
  scope?: 'sentence' | 'paragraph' | 'full';
  turnScope?: 'single' | 'conversation' | null;
  rubricItems?: RubricItem[];
  assistantId?: string | null;    // NOTE: assistantId, NOT personaId (fix F9/F2)
  
  // Metadata
  version: number;                // For cache invalidation
  updatedAt: Date;
}
```

### 1.2 BFF Representation (Prisma Schema)

BFF owns the single source of truth for rules. System validators seeded as `kind='system'` rows.

```prisma
// packages/bff/prisma/schema.prisma

model UnifiedRule {
  key            String    // e.g., 'language-guard', 'custom-rule-123' (NOT global @id — fix F5)
  tenantId       String
  kind           String    // 'system' | 'custom'
  enabled        Boolean   @default(true)
  mode           String?   // 'active' | 'dry-run' (real validator_mode)
  terminalOnFail Boolean   @default(false)
  priority       Int       @default(0)  // Lower = earlier in pipeline
  
  // System validator fields
  validatorType  String?   // 'language-guard' | 'false-promise' | 'identity-guard' (NOT format-injection — fix F6)
  
  // Custom rule fields (must carry full CorrectionRule payload — fix F2)
  detector       Json?     // DetectorConfig (regex/keyword/pattern/semantic)
  rewriteInstruction String?
  customRuleMode String?   // 'rewrite' | 'score' (DAR mode)
  scope          String?   // 'sentence' | 'paragraph' | 'full'
  turnScope      String?   // 'single' | 'conversation'
  rubricItems    Json?
  assistantId    String?   // NOTE: assistantId, NOT personaId
  
  // Metadata
  version        Int       @default(1)
  updatedAt      DateTime  @updatedAt
  createdAt      DateTime  @default(now())
  
  // Relations
  tenant         Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  
  // Composite PK (fix F5: global key @id collides across tenants)
  @@id([tenantId, key])
  
  // Prevent deletion of system rules (enforced at API layer)
  @@index([tenantId, kind, priority])
  @@unique([tenantId, priority])
  @@map("unified_rules")
}
```

**Migration strategy**:

1. Create `unified_rules` table
2. Backfill from existing `CorrectionRule` (kind='custom') + seed system validators
3. Deprecate `ValidatorConfig` (026) — migrate to `unified_rules` (kind='system')
4. Deprecate `CorrectionRule` — migrate to `unified_rules` (kind='custom')
5. Drop old tables after validation period

## 2. Unified Log Model

### 2.1 Engine Emission (`QualityEventPush`)

Engine emits unified events to BFF via existing push channel.

```typescript
// packages/core/src/types/quality.ts

export interface QualityEventPush {
  ts: Date;                        // Unified timestamp (ISO 8601)
  kind: RuleKind;                  // 'system' | 'custom'
  ruleKey: string;                 // References UnifiedRule.key
  verdict: VerdictCoarse;          // Coarse verdict (filterable)
  detail?: VerdictDetail;          // Native subtype (for audit)
  shortCircuitedBy?: string;       // Rule key that triggered short-circuit
  
  // Context — PRESERVE existing fields from live wire type (fix F3)
  idempotencyKey: string;          // Dedup key (existing — REQUIRED)
  assistantId: string;             // Per-persona dashboards (existing — REQUIRED)
  conversationId: string;
  messageId?: string;
  ruleId?: string;                 // Legacy rule ID (existing)
  ruleName?: string;               // Human-readable rule name (existing)
  snapshotVersion?: string;        // Rule cache version (existing)
  
  // Metrics
  latencyMs?: number;              // Stage execution time
  score?: number;                  // LLM-assigned quality score (0-1)
  
  // Translation-specific (024)
  sourceLang?: string;
  targetLang?: string;
  
  // Response snippets (fix F3: preserve original field names for backward compat)
  originalText?: string;           // Truncated to 500 chars max; shorter = as-is
  rewrittenText?: string;          // Truncated to 500 chars max (if corrected)
  
  // Legacy fields (preserved for backward compat — fix F3)
  legacyMode?: string;             // '018-dar-pipeline' for existing DAR events
  rolledBack?: boolean;            // DAR rollback indicator
}
```

### 2.2 BFF Persistence (`QualityEvent` Table)

BFF persists unified events to single table (replaces separate `QualityEvent` + `validator_runs` backfill).

```prisma
// packages/bff/prisma/schema.prisma

model QualityEvent {
  id              String    @id @default(cuid())
  
  // Unified fields
  ts              DateTime  @db.Timestamptz
  kind            String    // 'system' | 'custom'
  ruleKey         String
  verdict         String    // 'pass' | 'block' | 'warn' | 'corrected'
  detail          String?   // 'translated' | 'regenerated' | 'rewritten' | 'rolled_back' | 'stripped' | 'degraded' | 'skipped'
  shortCircuitedBy String?
  
  // Context
  conversationId  String
  messageId       String?
  
  // Metrics
  latencyMs       Int?
  score           Float?
  
  // Translation-specific
  sourceLang      String?
  targetLang      String?
  
  // Responses (truncated for storage)
  originalResponseSnippet String?  // First 500 chars
  modifiedResponseSnippet  String?  // First 500 chars
  
  // Metadata
  createdAt       DateTime  @default(now())
  
  // Relations
  conversation    Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  
  @@index([conversationId, ts])
  @@index([ruleKey, verdict])
  @@index([kind, ts])
  @@map("quality_events")
}
```

**Migration strategy**:

1. Add new columns to existing `QualityEvent` table (or create new unified table)
2. Backfill historical `validator_runs` → `quality_events` (kind='system')
3. Update product-028 to read from unified table
4. Deprecate `validator_runs` (engine-internal, kept for 90 days)
5. Drop `validator_runs` after validation period

## 3. Verdict Mapping

### 3.1 Old → New Mapping (Engine-side)

Executed in `response-guard.ts` on emit, NOT in UI.

**Re-derived from REAL validator_runs schema** (`models/validators.ts:29-52`): columns are `verdict` (enum: `no_op|append_disclaimer|block|rewrite|error|strip|pass`), `isDryRun`, `validatorName`, `confidence`, `matchedPatterns`, `originalContent`, `remediatedContent`, `createdAt`.

| Source | Real Column | Condition | New Verdict | New Detail |
|--------|-------------|-----------|-------------|------------|
| `validator_runs` | `verdict='pass'` | — | `pass` | — |
| `validator_runs` | `verdict='no_op'` | — | `pass` | `skipped` |
| `validator_runs` | `verdict='block'` | — | `block` | — |
| `validator_runs` | `verdict='error'` | — | `block` | `degraded` |
| `validator_runs` | `verdict='strip'` | — | `corrected` | `stripped` |
| `validator_runs` | `verdict='rewrite'` | — | `corrected` | `rewritten` |
| `validator_runs` | `verdict='append_disclaimer'` | — | `corrected` | `rewritten` |
| `validator_runs` | `isDryRun=true` | ANY | `warn` | `skipped` (audit-only, no mutation) |
| `QualityEvent` | `verdict='pass'` | — | `pass` | — |
| `QualityEvent` | `verdict='fail'` + `rewritten=true` | — | `corrected` | `rewritten` |
| `QualityEvent` | `verdict='fail'` + `rolled_back=true` | — | `block` | `rolled_back` |
| `QualityEvent` | `verdict='fail'` + `translated=true` | — | `corrected` | `translated` |
| `QualityEvent` | `verdict='fail'` + `regenerated=true` | — | `corrected` | `regenerated` |

### 3.2 Pipeline Verdict Flow

```
Stage 1: language-guard (system, response-side)
  ├─ pass → continue
  ├─ block (terminalOnFail=true) → shortCircuitedBy='language-guard', STOP
  └─ warn → continue

Stage 2: false-promise (system, response-side)
  ├─ pass → continue
  ├─ block (terminalOnFail=true) → shortCircuitedBy='false-promise', STOP
  └─ warn → continue

Stage 3: identity-guard (system, response-side)
  ├─ pass → continue
  ├─ block (terminalOnFail=true) → shortCircuitedBy='identity-guard', STOP
  └─ warn → continue

NOTE: format-injection is an INPUT validator (runs via validateInput on user message),
NOT a response validator. It is excluded from the response guard pipeline (fix F6).

Stage 4: custom-rule tier (custom, LLM — all custom rules in ONE darExecute call, fix F4)
  ├─ pass → continue
  ├─ fail → DAR rewrite → detail='rewritten' → re-validate
  └─ fail (terminalOnFail=true) → shortCircuitedBy=ruleKey, STOP

Stage 5: re-validator (system, post-rewrite)
  ├─ pass → corrected response returned
  ├─ block → detail='rolled_back', original response returned
  └─ warn → corrected response returned (with warning)
```

## 4. State Transitions

### 4.1 Response Guard State Machine

```
IDLE
  ↓
RUNNING (stage execution)
  ├─ [stage passes] → NEXT STAGE
  ├─ [stage fails, terminalOnFail=true] → SHORT_CIRCUITED
  └─ [all stages complete] → COMPLETED
      ↓
RESPONSE_READY (with final verdict + modified response)
```

### 4.2 Rule Cache State

```
INITIAL (engine startup)
  ↓
LOADING (fetching from BFF)
  ↓
READY (rules cached)
  ├─ [rules-reload push] → UPDATING
  └─ [cache expiry] → STALE (continue serving, fetch in background)
      ↓
READY (updated)
```

## 5. Indexing Strategy

### 5.1 Engine (In-Memory)

Keyed by `(tenantId, personaId)` composite — fix F9: real config/rules are per-persona (`getRules(tenantId, personaId)` in `dar-pipeline.ts:32`, `validator_configs` unique on `(tenantId, personaId, validatorName)`).

```typescript
// Rule cache structure (fix F9)
Map<string, Map<string, UnifiedRule[]>>  // outer: tenantId, inner: personaId → rules
```

Tenant eviction: entries not accessed in 24h are evicted (fix opencode F1: memory leak on tenant deletion).

### 5.2 BFF (Postgres)

```sql
-- Primary lookup: conversation history
CREATE INDEX idx_quality_events_conversation_ts 
  ON quality_events (conversationId, ts DESC);

-- Rule performance analysis
CREATE INDEX idx_quality_events_rule_verdict 
  ON quality_events (ruleKey, verdict);

-- System vs custom filtering (product-028 dashboards)
CREATE INDEX idx_quality_events_kind_ts 
  ON quality_events (kind, ts DESC);

-- Tenant isolation (if multi-tenant in single DB)
CREATE INDEX idx_quality_events_tenant 
  ON quality_events ((conversation->>'tenantId'));
```

## 6. Migration Scripts

### 6.1 Backfill: `validator_runs` → `quality_events`

```sql
-- File: packages/bff/prisma/migrations/027_backfill_validator_runs.sql
-- Review required (Standing Order 5)
-- Re-derived from REAL validator_runs columns (fix F1):
--   verdict (enum: no_op|append_disclaimer|block|rewrite|error|strip|pass)
--   validator_name (text), is_dry_run (boolean), confidence (float),
--   original_content (text), remediated_content (text), created_at (timestamptz)

INSERT INTO quality_events (
  ts,
  kind,
  ruleKey,
  verdict,
  detail,
  conversationId,
  messageId,
  latencyMs,
  originalResponseSnippet,
  modifiedResponseSnippet,
  createdAt
)
SELECT
  created_at AS ts,
  'system' AS kind,
  validator_name AS ruleKey,  -- Direct name mapping (validator_name already carries the key)
  CASE 
    WHEN verdict = 'pass' THEN 'pass'
    WHEN verdict = 'no_op' THEN 'pass'
    WHEN verdict = 'block' THEN 'block'
    WHEN verdict = 'error' THEN 'block'
    WHEN verdict = 'strip' THEN 'corrected'
    WHEN verdict = 'rewrite' THEN 'corrected'
    WHEN verdict = 'append_disclaimer' THEN 'corrected'
    ELSE 'pass'
  END AS verdict,
  CASE
    WHEN verdict = 'no_op' THEN 'skipped'
    WHEN verdict = 'error' THEN 'degraded'
    WHEN verdict = 'strip' THEN 'stripped'
    WHEN verdict IN ('rewrite', 'append_disclaimer') THEN 'rewritten'
    WHEN is_dry_run = true THEN 'skipped'
    ELSE NULL
  END AS detail,
  conversation_id AS conversationId,
  message_id AS messageId,
  latency_ms AS latencyMs,
  LEFT(original_content, 500) AS originalResponseSnippet,
  LEFT(remediated_content, 500) AS modifiedResponseSnippet,
  created_at AS createdAt
FROM engine.validator_runs  -- Cross-DB reference (requires dblink or manual export)
WHERE created_at < NOW() - INTERVAL '30 days'  -- Backfill historical, exclude recent
LIMIT 100000;  -- Batch processing (fix F7: chunked backfill)
```

**Note**: Cross-DB backfill requires either:

1. `dblink` extension (Postgres → Postgres)
2. Export `validator_runs` to CSV, import into BFF
3. BFF read-time merge (transitional, no backfill)

**Recommended**: Option 2 (CSV export/import) for safety + auditability.

### 6.2 Seed: System Validators

```typescript
// packages/bff/src/services/rules/seed-system-validators.ts
// fix F6: format-injection is INPUT validator — NOT seeded as response-stage rule
// fix F8: mode defaults to 'dry-run' for language-guard + identity-guard (preserves NFR-4)

const SYSTEM_RULES: Omit<UnifiedRule, 'createdAt' | 'updatedAt'>[] = [
  {
    key: 'language-guard',
    kind: 'system',
    enabled: true,
    mode: 'dry-run',           // fix F8: defaults to dry-run (audit-only), NOT 'standard'
    terminalOnFail: true,      // block → stop pipeline
    priority: 1,
    validatorType: 'language-guard',
    version: 1,
  },
  {
    key: 'false-promise',
    kind: 'system',
    enabled: true,
    mode: 'active',            // false-promise defaults to active
    terminalOnFail: true,      // block → stop pipeline
    priority: 2,
    validatorType: 'false-promise',
    version: 1,
  },
  {
    key: 'identity-guard',
    kind: 'system',
    enabled: true,
    mode: 'dry-run',           // fix F8: defaults to dry-run (audit-only)
    terminalOnFail: true,      // block → stop pipeline
    priority: 3,
    validatorType: 'identity-guard',
    version: 1,
  },
  // NOTE: format-injection removed from response guard (fix F6).
  // It validates USER INPUT (validateInput), not response text.
  // Input validation stays as a separate pipeline stage.
];

export async function seedSystemValidators(tenantId: string): Promise<void> {
  for (const rule of SYSTEM_RULES) {
    // fix F5: upsert on composite (tenantId, key), NOT global key
    await prisma.unifiedRule.upsert({
      where: { tenantId_key: { tenantId, key: rule.key } },
      update: rule,
      create: { ...rule, tenantId },
    });
  }
}
```

**Idempotency**: `upsert` ensures re-running doesn't duplicate.

## 7. Constraints & Invariants

1. **System rules non-removable**: BFF API rejects DELETE requests for `kind='system'` rules.
2. **Priority uniqueness**: No two rules can share the same `priority` for a `(tenantId, personaId)` pair.
3. **TerminalOnFail defaults** (fix F8): `block` validators default to `true`; `warn`/`corrected`/custom → `false`. Per FR-002, NOT uniformly true.
4. **Mode defaults** (fix F8): `language-guard` + `identity-guard` default to `dry-run` (audit-only). `false-promise` defaults to `active`. Preserves NFR-4.
5. **Composite key** (fix F5): `@@id([tenantId, key])` — rules are per-tenant, global `key` collides.
6. **Timestamp unification**: All events use `ts` field (ISO 8601); legacy `createdAt` mapped on emit.
7. **Verdict coarse+detail**: `verdict` is filterable; `detail` is for audit. Both populated on every event.
8. **Cross-DB consistency**: Engine never reads BFF DB directly; BFF never reads engine DB directly. All cross-service data flows via push channel.
9. **Fail-open** (fix F10): If guard throws, chat-service delivers last-good text + logs `degraded` event. Never 500.
10. **Rule-cache key** (fix F9): Cache keyed by `(tenantId, personaId)`, NOT tenantId-only. Per-persona rules preserved.
