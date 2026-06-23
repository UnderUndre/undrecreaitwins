# Contract: QualityEventPush (Engine → BFF)

**Feature**: 027-validators-quality-convergence  
**Date**: 2026-06-23  
**Status**: Draft  
**Direction**: Engine → BFF (push channel)

## 1. Overview

Unified event format for both system validators and custom quality rules. Replaces separate `validator_runs` logging and `QualityEvent` emission.

**fix F3**: This contract is ADDITIVE over the existing `QualityEventPush` type defined in `correction-rules/types.ts:32-47`. Existing fields (`idempotencyKey`, `ruleId`, `ruleName`, `assistantId`, `mode`, `rolledBack`, `snapshotVersion`, `originalText`, `rewrittenText`) are PRESERVED. New fields (`kind`, `detail`, `shortCircuitedBy`, `sourceLang`, `targetLang`) are added alongside. This is NOT a breaking wire change.

## 2. Schema

```typescript
// packages/core/src/types/quality.ts

export type RuleKind = 'system' | 'custom';
export type VerdictCoarse = 'pass' | 'block' | 'warn' | 'corrected';
export type VerdictDetail = 
  | 'translated' 
  | 'regenerated' 
  | 'rewritten' 
  | 'rolled_back' 
  | 'stripped' 
  | 'degraded' 
  | 'skipped';

export interface QualityEventPush {
  ts: Date;                        // Unified timestamp (ISO 8601, UTC)
  kind: RuleKind;                  // NEW: 'system' (validator) | 'custom' (DAR rule)
  ruleKey: string;                 // NEW: References UnifiedRule.key
  verdict: VerdictCoarse;          // Extended: 'pass' | 'block' | 'warn' | 'corrected' (was pass/fail)
  detail?: VerdictDetail;          // NEW: Native subtype (for audit)
  shortCircuitedBy?: string;       // NEW: Rule key that triggered short-circuit
  
  // PRESERVED from existing wire type (correction-rules/types.ts:32-47 — fix F3)
  idempotencyKey: string;          // REQUIRED: dedup key (existing)
  conversationId: string;          // Existing
  messageId?: string;              // Existing
  assistantId: string;             // REQUIRED: per-persona dashboards (existing)
  ruleId?: string;                 // Legacy rule ID (existing)
  ruleName?: string;               // Human-readable rule name (existing)
  snapshotVersion?: string;        // Rule cache version (existing)
  mode?: string;                   // Legacy mode (existing, e.g., '018-dar-pipeline')
  rolledBack?: boolean;            // DAR rollback indicator (existing)
  
  // Response text (PRESERVE existing field names — fix F3, NOT originalResponse/modifiedResponse)
  originalText?: string;           // Truncated to 500 chars max; shorter = as-is (existing)
  rewrittenText?: string;          // Truncated to 500 chars max (existing)
  
  // Metrics
  latencyMs?: number;              // Existing
  score?: number;                  // Existing (LLM-assigned quality score 0-1)
  
  // Translation-specific (024) — NEW fields
  sourceLang?: string;
  targetLang?: string;
}
```

## 3. Field Specifications

### 3.1 Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `ts` | `Date` | Event timestamp (UTC). Replaces legacy `runAt` (validators) and `createdAt` (DAR). |
| `kind` | `'system' \| 'custom'` | Event source. `system` = built-in validator; `custom` = LLM-based rule. |
| `ruleKey` | `string` | Unique rule identifier. Maps to `UnifiedRule.key`. |
| `verdict` | `VerdictCoarse` | Coarse outcome. Filterable for dashboards. |
| `conversationId` | `string` | Conversation context (required for BFF persistence). |

### 3.2 Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `messageId` | `string` | Message context (if available). |
| `detail` | `VerdictDetail` | Native subtype for audit. Omitted for `pass` verdicts. |
| `shortCircuitedBy` | `string` | Rule key that triggered short-circuit. Present only if pipeline stopped early. |
| `latencyMs` | `number` | Stage execution time. Required for performance monitoring. |
| `score` | `number` | LLM-assigned quality score (0-1). Present only for `custom` rules with LLM evaluation. |
| `sourceLang` | `string` | Source language code (ISO 639-1). Present only for translation rules. |
| `targetLang` | `string` | Target language code (ISO 639-1). Present only for translation rules. |
| `originalResponse` | `string` | Original response text (truncated to 500 chars). |
| `modifiedResponse` | `string` | Modified response text (truncated to 500 chars). Present only if response was corrected. |

## 4. Verdict Mapping

### 4.1 System Validators (Old → New)

| Source | Old Verdict | Old Severity | New Verdict | New Detail |
|--------|-------------|--------------|-------------|------------|
| `validator_runs` | `passed=false` | — | `pass` | — |
| `validator_runs` | `passed=true` | `severity='error'` | `block` | — |
| `validator_runs` | `passed=true` | `severity='warn'` | `warn` | — |

**Mapping logic** (engine-side, in `response-guard.ts`):

```typescript
function mapValidatorVerdict(passed: boolean, severity: string): VerdictCoarse {
  if (!passed) return 'pass';
  if (severity === 'error') return 'block';
  if (severity === 'warn') return 'warn';
  return 'pass';
}
```

### 4.2 Custom Rules (Old → New)

| Source | Old Verdict | Old Condition | New Verdict | New Detail |
|--------|-------------|---------------|-------------|------------|
| `QualityEvent` | `pass` | — | `pass` | — |
| `QualityEvent` | `fail` | `rewritten=true` | `corrected` | `rewritten` |
| `QualityEvent` | `fail` | `rolled_back=true` | `block` | `rolled_back` |
| `QualityEvent` | `fail` | `translated=true` | `corrected` | `translated` |
| `QualityEvent` | `fail` | `regenerated=true` | `corrected` | `regenerated` |

**Mapping logic** (engine-side, in `dar-pipeline.ts`):

```typescript
function mapDARVerdict(verdict: string, rewritten: boolean, rolledBack: boolean): VerdictCoarse {
  if (verdict === 'pass') return 'pass';
  if (rolledBack) return 'block';
  if (rewritten) return 'corrected';
  return 'block';  // fail without correction
}
```

## 5. Emission Protocol

### 5.1 Push Channel

**Existing channel**: Engine → BFF via `QualityEventPush[]` (already implemented in `dar-pipeline.ts:90`)

**Transport**: In-process message queue or HTTP webhook (implementation-dependent)

**Batch semantics**:

- Single stage → array of 1 event
- Multiple stages → array of N events
- Empty array → no events (all stages passed without logging, or logging disabled)

### 5.2 Emission Timing

```
Stage execution completes
  ↓
Map verdict to unified format
  ↓
Emit QualityEventPush to channel
  ↓
BFF receives and persists
  ↓
Continue to next stage (or return final response)
```

**Important**: Emission is synchronous within stage execution (blocking). BFF persistence is async (fire-and-forget from engine perspective).

### 5.3 Error Handling

| Scenario | Engine Behavior | BFF Behavior |
|----------|----------------|--------------|
| Push channel unavailable | Log warning, continue pipeline | N/A |
| BFF persistence failure | N/A | Log error, retry with backoff |
| Malformed event | Reject, log error | N/A |
| Missing required field | Reject, log error | N/A |

## 6. Backward Compatibility

### 6.1 Legacy Fields (Deprecated)

| Legacy Field | Replacement | Deprecation Date |
|--------------|-------------|------------------|
| `validator_runs.runAt` | `ts` | 2026-06-23 |
| `validator_runs.passed` | `verdict` | 2026-06-23 |
| `validator_runs.severity` | `verdict` + `detail` | 2026-06-23 |
| `QualityEvent.createdAt` | `ts` | 2026-06-23 |
| `QualityEvent.mode` | `kind` | 2026-06-23 |
| `QualityEvent.verdict` (old enum) | `verdict` (new enum) | 2026-06-23 |

### 6.2 Migration Path

1. **Phase 1** (this feature): Engine emits new `QualityEventPush` format. BFF accepts both old and new formats.
2. **Phase 2** (backfill): Historical `validator_runs` migrated to BFF `quality_events` table (kind='system').
3. **Phase 3** (cleanup): Engine stops logging to `validator_runs` (table retained for 90 days, then dropped).

## 7. Consumer Impact

### 7.1 Product-028 (UI)

**Before**: Reads from two sources, normalizes in UI layer.

- `validator_runs` (engine DB) → normalization adapter
- `QualityEvent` (BFF DB) → direct read

**After**: Reads from single source, no normalization.

- `quality_events` (BFF DB) → direct read

**Breaking change**: Yes (UI layer changes required). Mitigated by:

- Backfill provides historical data in new format
- Feature flag allows gradual rollout
- Old tables retained for 90 days

### 7.2 Analytics/Audit

**Before**: Two query patterns for system vs custom rules.

**After**: Single query pattern with `kind` filter.

**Benefit**: Simplified queries, consistent schema.

## 8. Validation

### 8.1 Schema Validation (BFF)

```typescript
// packages/bff/src/services/quality-events/validator.ts

const QualityEventPushSchema = z.object({
  ts: z.coerce.date(),
  kind: z.enum(['system', 'custom']),
  ruleKey: z.string().min(1),
  verdict: z.enum(['pass', 'block', 'warn', 'corrected']),
  detail: z.enum([
    'translated', 'regenerated', 'rewritten', 'rolled_back',
    'stripped', 'degraded', 'skipped'
  ]).optional(),
  shortCircuitedBy: z.string().optional(),
  conversationId: z.string().uuid(),
  messageId: z.string().uuid().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  score: z.number().min(0).max(1).optional(),
  sourceLang: z.string().length(2).optional(),
  targetLang: z.string().length(2).optional(),
  originalResponse: z.string().max(500).optional(),
  modifiedResponse: z.string().max(500).optional(),
});
```

### 8.2 Contract Tests

- **Test 1**: System validator emits `kind='system'`, correct verdict mapping
- **Test 2**: Custom rule emits `kind='custom'`, correct verdict mapping
- **Test 3**: Short-circuit event includes `shortCircuitedBy`
- **Test 4**: Translation rule includes `sourceLang` + `targetLang`
- **Test 5**: Missing required fields → rejection (400)
- **Test 6**: Malformed enum values → rejection (400)
