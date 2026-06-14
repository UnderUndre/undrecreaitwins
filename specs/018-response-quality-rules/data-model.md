# Data Model: 018 Response Quality Rules Runtime

## Overview

**No new Engine DB tables.** Correction rules are external — pulled from Product (ai-twins 019) via HTTP, cached in-memory. Quality events are pushed TO Product via HTTP, not stored in Engine DB.

The "data model" here is the **TypeScript type system** that defines the contract between Engine code modules + the cross-repo HTTP boundary.

## Types

### CorrectionRule (read from Product via HTTP)

```typescript
interface CorrectionRule {
  id: string;                          // UUID (Product PK)
  tenantId: string;                    // UUID
  assistantId: string | null;          // UUID or null = tenant default
  name: string;
  detector: DetectorConfig;            // discriminated union by type
  rewriteInstruction: string | null;   // NL instruction; required when mode='rewrite'
  mode: 'rewrite' | 'score';
  priority: number;                    // lower = higher (1=top, 100=default)
  scope: 'sentence' | 'paragraph' | 'full';
  turnScope: 'single' | 'conversation' | null;
  isEnabled: boolean;
  rubricItems: RubricItem[] | null;    // binary checklist for semantic rules
}

interface RubricItem {
  id: string;
  text: string;
  required: boolean;
}
```

### DetectorConfig (discriminated union)

```typescript
type DetectorConfig =
  | { type: 'regex'; config: { pattern: string; flags?: string } }
  | { type: 'keyword'; config: { words: string[]; matchAll?: boolean } }
  | { type: 'pattern'; config: { description: string } }
  | { type: 'semantic'; config: { prompt: string; rubricItems?: RubricItem[] } };
```

### QualityEventPush (written to Product via HTTP)

```typescript
interface QualityEventPush {
  assistantId: string;
  ruleId: string;
  ruleName: string;
  conversationId: string | null;
  messageId: string | null;
  mode: 'rewrite' | 'score';
  verdict: QualityVerdict;
  originalText?: string;               // null in score mode (privacy)
  rewrittenText?: string;              // null in score mode
  score?: number;
  latencyMs: number;
  rolledBack: boolean;
}

type QualityVerdict = 'pass' | 'fail' | 'rewritten' | 'rolled_back' | 'overflow_skipped';
```

### RuleCacheEntry (in-memory only)

```typescript
interface RuleCacheEntry {
  rules: CorrectionRule[];
  snapshotVersion: string;             // ETag for conditional GET
  fetchedAt: number;                   // epoch ms
}
```

### DARResult (internal pipeline output)

```typescript
interface DARResult {
  text: string;                        // final text (rewritten or original)
  events: QualityEventPush[];          // events to push to Product
  latencyMs: number;                   // total DAR latency
  stages: {
    detect: { triggered: number; skipped: number };
    aggregate: { rewriteCapped: number; overflowSkipped: number };
    rewrite?: { latencyMs: number; model: string };
    revalidation?: { verdict: 'pass' | 'fail'; rolledBack: boolean };
  };
}
```

### Detector Interface

```typescript
interface Detector {
  detect(text: string, rule: CorrectionRule): Promise<DetectorResult>;
}

interface DetectorResult {
  triggered: boolean;
  score?: number;                      // confidence 0-1 (semantic/pattern)
  latencyMs: number;
}
```

## File Location

All types in `packages/core/src/services/correction-rules/types.ts`. Exported from the module index.

## Relationship to 004 Models

| 004 Model | 018 Concept | Relationship |
|-----------|-------------|-------------|
| `ValidatorPipeline` | `DARPipeline` | 004 = structural safety baseline (runs first). 018 = custom quality layer (runs after). |
| `FalsePromiseValidator` | `ReValidator` (reuse) | 018 re-instantiates the 004 false-promise validator directly for post-rewrite re-validation. |
| `IdentityGuardValidator` | `ReValidator` (reuse) | Same — 018 re-instantiates 004 identity-guard for re-validation. |
| `validatorConfigs` (DB) | `CorrectionRule` (HTTP) | 004 config in Engine DB. 018 config in Product DB, pulled via HTTP. Different ownership, no overlap. |

**No schema changes to 004 models.** 018 adds zero Engine DB tables.
