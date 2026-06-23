# Research: Validators ⊕ Quality Rules Convergence

**Feature**: 027-validators-quality-convergence  
**Date**: 2026-06-23  
**Status**: Complete

## 1. Existing Codebase Analysis

### 1.1 Validator Pipeline (Engine)

**Location**: `packages/core/src/services/validators/`

**Current architecture**:

- `pipeline.ts` — `ValidatorPipeline.validateResponse()` orchestrates 4 deterministic validators
- Validators: `language-guard`, `false-promise`, `format-injection`, `identity-guard`
- Each returns verdict: `pass | strip | block | warn`
- Logs to engine Postgres table `validator_runs` (fields: `passed`, `severity`, `runAt`)
- Cost: $0 on happy-path (no LLM)

**Key classes**:

```typescript
// packages/core/src/services/validators/pipeline.ts
class ValidatorPipeline {
  validateResponse(response: string, ctx: ValidationContext): ValidatorResult;
}

// Individual validators (e.g., language-guard.ts)
class LanguageGuard implements Validator {
  validate(response: string): ValidatorVerdict;
}
```

### 1.2 DAR Pipeline (Correction Rules)

**Location**: `packages/core/src/services/correction-rules/`

**Current architecture**:

- `dar-pipeline.ts` — `darExecute()` runs Detect-Analyze-Rewrite via LLM
- Triggered by custom quality rules (018) from BFF
- Returns verdict: `pass | fail | rewritten | rolled_back`
- Emits `QualityEventPush` to BFF (fields: `mode='018-dar-pipeline'`, `score`, `latencyMs`, `createdAt`)
- Cost: LLM call per rule violation

**Key integration**:

```typescript
// packages/core/src/services/correction-rules/dar-pipeline.ts
function darExecute(response: string, rules: CorrectionRule[]): QualityEventPush[];
```

### 1.3 Re-Validator (Existing Convergence Point)

**Location**: `packages/core/src/services/correction-rules/re-validator.ts`

**Purpose**: Re-validates rewritten text using the same validator classes (`FalsePromise`, `IdentityGuard`, `LanguageGuard`)

**Significance**: Validators and correction rules already share machinery. The gap is orchestration, not implementation.

### 1.4 Cross-DB Architecture

**Engine DB** (Postgres + Drizzle):

- `validator_runs` table (engine-internal)
- `rule-cache` (pushed from BFF)

**BFF DB** (Postgres + Prisma):

- `QualityEvent` table (unified log target)
- `CorrectionRule` table (custom rules)
- `ValidatorConfig` table (026, per-tenant/persona validator config)

**Push channel**: Engine → BFF via `QualityEventPush` (existing in `dar-pipeline.ts:90`)

## 2. Key Technical Decisions

### 2.1 Unified Orchestrator: `ResponseGuard`

**Decision**: Refactor `ValidatorPipeline` into `ResponseGuard` that orchestrates both deterministic and LLM stages.

**Rationale**:

- Build-on path B (per spec clarification): generalize existing `ValidatorPipeline`, don't fork
- Preserves existing validator classes (reuse, don't rewrite)
- DAR becomes a configurable stage after deterministic validators
- Single entry point: `responseGuard.run(response, ctx)`

**Alternatives considered**:

- Fork/rewrite chat-service: Rejected (violates build-on principle, high risk)
- Keep separate pipelines + UI normalization: Rejected (symptom treatment, product-028 approach)

### 2.2 Tiered Stage Order

**Decision**: Deterministic validators first (cheap), then LLM stages (DAR, translate/regenerate from 024), then re-validation.

**Configuration**: Per-rule `terminalOnFail` flag controls short-circuit behavior.

**Defaults** (cost-safety, NFR-1):

- `block` validators → `terminalOnFail=true` (stop pipeline, no LLM)
- `warn`/`strip` validators → `terminalOnFail=false` (continue to LLM stages)
- Custom rules → `terminalOnFail=false` (continue to re-validation)

**Rationale**: Prevents unnecessary LLM calls on clear violations (cost parity).

### 2.3 Unified Log Model

**Decision**: Validators emit `QualityEventPush` (`kind='system'`) to existing engine→BFF channel. BFF persists to unified `QualityEvent` table.

**Schema**:

```typescript
interface QualityEventPush {
  ts: Date;                          // Unified timestamp (replaces runAt + createdAt)
  kind: 'system' | 'custom';         // System validator vs custom rule
  ruleKey: string;                   // e.g., 'language-guard', 'custom-rule-123'
  verdict: 'pass' | 'block' | 'warn' | 'corrected';  // Coarse (filterable)
  detail?: string;                   // Native subtype: 'translated' | 'regenerated' | 'rewritten' | 'rolled_back' | 'stripped' | 'degraded' | 'skipped'
  shortCircuitedBy?: string;         // Rule key that triggered short-circuit
  sourceLang?: string;               // For translate rules
  targetLang?: string;               // For translate rules
  score?: number;                    // LLM-assigned quality score
  latencyMs?: number;                // Stage execution time
  conversationId: string;
  messageId?: string;
}
```

**Mapping old → new** (in engine on emit, NOT in UI):

- `validator_runs.passed=true` + `severity='error'` → `verdict='block'`
- `validator_runs.passed=true` + `severity='warn'` → `verdict='warn'`
- `validator_runs.passed=false` → `verdict='pass'`
- `QualityEvent.verdict='pass'` → `verdict='pass'`
- `QualityEvent.verdict='fail'` + `rewritten=true` → `verdict='corrected'`, `detail='rewritten'`
- `QualityEvent.verdict='fail'` + `rolled_back=true` → `verdict='block'`, `detail='rolled_back'`

**Rationale**:

- Cross-DB view impossible (engine Postgres vs BFF Postgres)
- Normalization once at emitter, not in UI
- `validator_runs` → engine-internal/deprecated (historical data backfilled via .sql)

### 2.4 Unified Config Store (BFF-Owned)

**Decision**: BFF owns the single rule-store. System validators seeded as `kind='system'` rows alongside custom rules.

**Flow**:

1. BFF seeds system validators (idempotent, on startup/migration)
2. BFF pushes system+custom rules to engine via existing `correction-rules-reload` → renamed `rules-reload`
3. Engine `rule-cache` stores unified rules (system + custom)
4. Engine `validator_configs` becomes cache/projection (not SOT)

**Config schema** (unified):

```typescript
interface UnifiedRule {
  key: string;                       // 'language-guard' | 'custom-rule-123'
  kind: 'system' | 'custom';
  enabled: boolean;
  mode?: string;                     // Validator-specific mode (e.g., 'strict' | 'lenient')
  terminalOnFail: boolean;           // Short-circuit flag
  priority: number;                  // Stage order (lower = earlier)
  // ... rule-specific fields (prompt, threshold, etc.)
}
```

**Rationale**:

- BFF already owns `CorrectionRule` + `ValidatorConfig` (026)
- Single source eliminates sync complexity
- System rules non-removable (enforced at BFF API layer)

### 2.5 Backward Compatibility

**Strategy**:

- Engine `validator_runs` table: deprecated but retained (historical data)
- Backfill script (`.sql` on review) migrates historical `validator_runs` → BFF `QualityEvent`
- Transitional period: BFF reads both sources, merges in query
- After backfill: `validator_runs` dropped (separate migration)

**API compatibility**:

- `chat-service.ts` call-sites updated to use `responseGuard.run()` (3 locations)
- No external API changes (BFF endpoints unchanged)
- Product-028 consumes unified `QualityEvent` table (no UI normalization needed)

## 3. Open Questions (Resolved)

| Question | Resolution | Source |
|----------|-----------|--------|
| Re-architect or build-on? | **Build-on (path B)** — generalize `ValidatorPipeline`, DAR becomes stage | Spec §Clarifications |
| Tiering/short-circuit? | **Per-rule `terminalOnFail`**, defaults: `block`→true, others→false | Spec §Clarifications |
| Cross-DB log unification? | **Validators emit `QualityEventPush`** (`kind='system'`), BFF persists to unified table | Spec §Clarifications |
| Cross-DB config ownership? | **BFF owns rule-store**, pushes system+custom to engine | Spec §Clarifications |
| Verdict granularity? | **Coarse + detail**: `verdict ∈ {pass,block,warn,corrected}` + `detail` with native subtype | Spec §Clarifications |

## 4. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM cost spike on happy-path | Low | High | `terminalOnFail=true` on `block` validators; regression tests verify LLM call count |
| Behavior parity break (004/017/018/024) | Medium | High | Regression suites run against old + new pipeline; feature flag for gradual rollout |
| Cross-service contract drift | Medium | Medium | Contract tests for `QualityEventPush` + `rules-reload`; versioned push channel |
| Backfill performance (historical `validator_runs`) | Low | Medium | `.sql` backfill run during maintenance window; BFF read-time merge as fallback |
| BFF rule-store migration | Low | High | Idempotent seeding; dual-write period; rollback via feature flag |

## 5. Dependencies

### 5.1 Internal Dependencies

| Feature | Dependency | Status |
|---------|-----------|--------|
| 004-validators | Validator classes (`LanguageGuard`, `FalsePromise`, etc.) | Landed |
| 017-language-guard-validator | `LanguageGuard` implementation | Landed |
| 018-response-quality-rules | DAR pipeline, `QualityEventPush` channel | Landed |
| 024-language-guard-rewrite-mirror | Re-validator, translate/regenerate remediation | Landed |
| 026-tuning | `ValidatorConfig` (BFF), per-tenant/persona config | Landed |

### 5.2 External Dependencies

- None (all dependencies are internal, landed features)

## 6. Implementation Strategy

### Phase 1: Core Orchestration (Engine)

1. Create `response-guard.ts` (orchestrator)
2. Refactor `ValidatorPipeline` → `ResponseGuard` (preserve validator classes)
3. Integrate DAR as configurable stage
4. Implement `terminalOnFail` short-circuit logic
5. Unified `QualityEventPush` emission (replace `validator_runs` logging)

### Phase 2: Unified Config (BFF)

1. Extend `CorrectionRule` schema to include system validators (`kind='system'`)
2. Seed system validators (idempotent)
3. Extend `rules-reload` push to include system+custom
4. Update engine `rule-cache` to accept unified rules

### Phase 3: Unified Log (BFF)

1. Modify BFF `QualityEvent` table schema (unified fields)
2. Update `quality-events/push.ts` to accept `kind='system'`
3. Generate backfill `.sql` (historical `validator_runs` → `QualityEvent`)
4. Update product-028 to consume unified table (thin UI)

### Phase 4: Migration & Cleanup

1. Deploy engine changes (response-guard, unified emission)
2. Deploy BFF changes (unified config + log)
3. Run backfill `.sql` (maintenance window)
4. Deprecate `validator_runs` (engine-internal only)
5. Remove UI normalization adapters (product-028)

## 7. Testing Strategy

### Unit Tests

- `response-guard.test.ts`: stage ordering, short-circuit, verdict mapping
- `unified-emitter.test.ts`: `QualityEventPush` shape, `kind` field, timestamp unification

### Integration Tests

- `chat-service.test.ts`: 3 call-sites use `responseGuard.run()`
- `rules-reload.test.ts`: BFF pushes system+custom, engine caches correctly
- `quality-events.test.ts`: BFF persists system+custom to unified table

### Regression Tests

- 004-validators suite: existing validator behavior unchanged
- 017-language-guard suite: language detection parity
- 018-response-quality-rules suite: DAR behavior parity
- 024-language-guard-rewrite-mirror suite: re-validation parity

### Performance Tests

- Happy-path latency: p95 ≤ max(current validateResponse, darExecute)
- LLM call count: 0 on happy-path for personas without custom rules
