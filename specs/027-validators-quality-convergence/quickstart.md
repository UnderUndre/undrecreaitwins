# Quickstart: Validators ⊕ Quality Rules Convergence

**Feature**: 027-validators-quality-convergence  
**Date**: 2026-06-23  
**Status**: Draft

## Prerequisites

- Engine service running (Node.js, TypeScript)
- BFF service running (ai-twins repo)
- Postgres databases (engine + BFF)
- Existing features 004/017/018/024/026 deployed

## Integration Steps

### Step 1: Deploy Engine Changes

#### 1.1 Create Unified Types

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

export interface UnifiedRule {
  key: string;
  kind: RuleKind;
  enabled: boolean;
  mode?: string;
  terminalOnFail: boolean;
  priority: number;
  validatorType?: string;
  prompt?: string;
  threshold?: number;
  version: number;
  updatedAt: Date;
}

export interface QualityEventPush {
  ts: Date;
  kind: RuleKind;
  ruleKey: string;
  verdict: VerdictCoarse;
  detail?: VerdictDetail;
  shortCircuitedBy?: string;
  conversationId: string;
  messageId?: string;
  latencyMs?: number;
  score?: number;
  sourceLang?: string;
  targetLang?: string;
  originalResponse?: string;
  modifiedResponse?: string;
}

export interface RulesReloadPush {
  version: number;
  snapshotVersion: string;
  tenantId: string;
  rules: UnifiedRule[];
  pushedAt: Date;
}
```

#### 1.2 Create Response Guard Orchestrator

```typescript
// packages/core/src/services/correction-rules/response-guard.ts

import { ValidatorPipeline } from '../validators/pipeline';
import { darExecute } from './dar-pipeline';
import { reValidate } from './re-validator';
import { QualityEventPush, UnifiedRule } from '../../types/quality';

export interface ResponseGuardContext {
  conversationId: string;
  messageId?: string;
  tenantId: string;
  personaId: string;
}

export interface ResponseGuardResult {
  response: string;
  verdict: 'pass' | 'block' | 'warn' | 'corrected';
  detail?: string;
  shortCircuitedBy?: string;
  events: QualityEventPush[];
}

export class ResponseGuard {
  private validatorPipeline: ValidatorPipeline;
  private ruleCache: Map<string, UnifiedRule[]>;

  constructor() {
    this.validatorPipeline = new ValidatorPipeline();
    this.ruleCache = new Map();
  }

  async run(response: string, ctx: ResponseGuardContext): Promise<ResponseGuardResult> {
    const startTime = Date.now();
    const events: QualityEventPush[] = [];
    let currentResponse = response;
    let shortCircuitedBy: string | undefined;

    // Get rules for tenant/persona
    const rules = this.ruleCache.get(ctx.tenantId) || [];
    const enabledRules = rules.filter(r => r.enabled);

    // Sort by priority (lower = earlier)
    const sortedRules = [...enabledRules].sort((a, b) => a.priority - b.priority);

    // Phase 1: System validators (deterministic, cheap)
    for (const rule of sortedRules.filter(r => r.kind === 'system')) {
      const stageStart = Date.now();
      const result = await this.runSystemValidator(rule, currentResponse, ctx);
      
      events.push({
        ts: new Date(),
        kind: 'system',
        ruleKey: rule.key,
        verdict: result.verdict,
        detail: result.detail,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        latencyMs: Date.now() - stageStart,
        originalResponse: response.slice(0, 500),
        modifiedResponse: result.modifiedResponse?.slice(0, 500),
      });

      if (result.verdict === 'block' && rule.terminalOnFail) {
        shortCircuitedBy = rule.key;
        return {
          response: result.modifiedResponse || currentResponse,
          verdict: 'block',
          shortCircuitedBy,
          events,
        };
      }

      if (result.modifiedResponse) {
        currentResponse = result.modifiedResponse;
      }
    }

    // Phase 2: Custom rules (LLM-based, expensive)
    for (const rule of sortedRules.filter(r => r.kind === 'custom')) {
      const stageStart = Date.now();
      const result = await this.runCustomRule(rule, currentResponse, ctx);
      
      events.push({
        ts: new Date(),
        kind: 'custom',
        ruleKey: rule.key,
        verdict: result.verdict,
        detail: result.detail,
        score: result.score,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        latencyMs: Date.now() - stageStart,
        originalResponse: response.slice(0, 500),
        modifiedResponse: result.modifiedResponse?.slice(0, 500),
      });

      if (result.verdict === 'block' && rule.terminalOnFail) {
        shortCircuitedBy = rule.key;
        return {
          response: result.modifiedResponse || currentResponse,
          verdict: 'block',
          shortCircuitedBy,
          events,
        };
      }

      if (result.modifiedResponse) {
        currentResponse = result.modifiedResponse;
      }
    }

    // Final verdict
    const hasCorrections = events.some(e => e.verdict === 'corrected');
    const hasWarnings = events.some(e => e.verdict === 'warn');
    const hasBlocks = events.some(e => e.verdict === 'block');

    let finalVerdict: ResponseGuardResult['verdict'] = 'pass';
    if (hasBlocks) finalVerdict = 'block';
    else if (hasCorrections) finalVerdict = 'corrected';
    else if (hasWarnings) finalVerdict = 'warn';

    return {
      response: currentResponse,
      verdict: finalVerdict,
      events,
    };
  }

  private async runSystemValidator(
    rule: UnifiedRule,
    response: string,
    ctx: ResponseGuardContext
  ): Promise<{ verdict: 'pass' | 'block' | 'warn'; modifiedResponse?: string; detail?: string }> {
    // Delegate to existing validator classes
    const result = await this.validatorPipeline.validateResponse(response, {
      ...ctx,
      validatorType: rule.validatorType,
      mode: rule.mode,
    });

    return {
      verdict: result.verdict === 'pass' ? 'pass' : result.verdict === 'block' ? 'block' : 'warn',
      modifiedResponse: result.modifiedResponse,
      detail: result.verdict === 'strip' ? 'stripped' : undefined,
    };
  }

  private async runCustomRule(
    rule: UnifiedRule,
    response: string,
    ctx: ResponseGuardContext
  ): Promise<{ verdict: 'pass' | 'block' | 'corrected'; modifiedResponse?: string; detail?: string; score?: number }> {
    // Delegate to existing DAR pipeline
    const result = await darExecute(response, [rule as any]);
    
    return {
      verdict: result.verdict === 'pass' ? 'pass' : result.rewritten ? 'corrected' : 'block',
      modifiedResponse: result.modifiedResponse,
      detail: result.rewritten ? 'rewritten' : result.rolledBack ? 'rolled_back' : undefined,
      score: result.score,
    };
  }

  updateRuleCache(tenantId: string, rules: UnifiedRule[]): void {
    this.ruleCache.set(tenantId, rules);
  }
}
```

#### 1.3 Update Chat-Service (3 call-sites)

```typescript
// packages/core/src/services/chat-service.ts

import { ResponseGuard } from './correction-rules/response-guard';

// BEFORE (3 separate calls):
// const validatorResult = await validatorPipeline.validateResponse(response, ctx);
// const darResult = await darExecute(response, rules);
// const reValidatorResult = await reValidate(darResult.modifiedResponse, ctx);

// AFTER (single call):
const responseGuard = new ResponseGuard();
const guardResult = await responseGuard.run(response, {
  conversationId: ctx.conversationId,
  messageId: ctx.messageId,
  tenantId: ctx.tenantId,
  personaId: ctx.personaId,
});

// Use guardResult.response (corrected) and guardResult.verdict
```

**Call-sites to update**:

1. `chat-service.ts:457` — happy-path response generation (`validateResponse` call-site)
2. `chat-service.ts:899` — buffered-delivery/streaming response generation
3. `chat-service.ts:1085` — agentic response generation (condition-gated at :1082-1084)
4. `chat-service.ts:481` — `darExecute` call-site (happy-path only today, fix F7: extend via per-call-site tier config)

#### 1.4 Update Rule Cache

```typescript
// packages/core/src/services/rule-cache/index.ts

import { RulesReloadPush, UnifiedRule } from '../types/quality';

export class RuleCacheService {
  private cache: Map<string, {
    version: number;
    snapshotVersion: string;
    rules: UnifiedRule[];
    loadedAt: Date;
  }> = new Map();

  async reload(push: RulesReloadPush): Promise<void> {
    // Validate version
    const current = this.cache.get(push.tenantId);
    if (current && push.version <= current.version) {
      throw new Error('Stale push: version not incremented');
    }

    // Update cache
    this.cache.set(push.tenantId, {
      version: push.version,
      snapshotVersion: push.snapshotVersion,
      rules: push.rules,
      loadedAt: new Date(),
    });

    logger.info({ tenantId: push.tenantId, version: push.version }, '[rule-cache] Updated');
  }

  getRules(tenantId: string): UnifiedRule[] {
    return this.cache.get(tenantId)?.rules || [];
  }
}
```

### Step 2: Deploy BFF Changes

#### 2.1 Update Prisma Schema

```prisma
// packages/bff/prisma/schema.prisma

model UnifiedRule {
  key            String    @id
  kind           String    // 'system' | 'custom'
  enabled        Boolean   @default(true)
  mode           String?
  terminalOnFail Boolean   @default(false)
  priority       Int       @default(0)
  validatorType  String?
  prompt         String?
  threshold      Float?
  version        Int       @default(1)
  updatedAt      DateTime  @updatedAt
  createdAt      DateTime  @default(now())
  tenantId       String
  tenant         Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId, kind, priority])
  @@map("unified_rules")
}

model QualityEvent {
  id                    String    @id @default(cuid())
  ts                    DateTime  @db.Timestamptz
  kind                  String
  ruleKey               String
  verdict               String
  detail                String?
  shortCircuitedBy       String?
  conversationId        String
  messageId             String?
  latencyMs             Int?
  score                 Float?
  sourceLang            String?
  targetLang            String?
  originalResponseSnippet String?
  modifiedResponseSnippet  String?
  createdAt             DateTime  @default(now())
  conversation          Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, ts])
  @@index([ruleKey, verdict])
  @@index([kind, ts])
  @@map("quality_events")
}
```

#### 2.2 Run Migration

```bash
# Generate migration
cd packages/bff
npx prisma migrate dev --name add-unified-rules-and-quality-events

# Apply to database
npx prisma db push
```

#### 2.3 Seed System Validators

```typescript
// packages/bff/src/services/rules/seed-system-validators.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SYSTEM_RULES = [
  {
    key: 'language-guard',
    kind: 'system',
    enabled: true,
    mode: 'standard',
    terminalOnFail: true,
    priority: 1,
    validatorType: 'language-guard',
    version: 1,
  },
  {
    key: 'false-promise',
    kind: 'system',
    enabled: true,
    mode: 'standard',
    terminalOnFail: true,
    priority: 2,
    validatorType: 'false-promise',
    version: 1,
  },
  {
    key: 'format-injection',
    kind: 'system',
    enabled: true,
    mode: 'standard',
    terminalOnFail: true,
    priority: 3,
    validatorType: 'format-injection',
    version: 1,
  },
  {
    key: 'identity-guard',
    kind: 'system',
    enabled: true,
    mode: 'standard',
    terminalOnFail: true,
    priority: 4,
    validatorType: 'identity-guard',
    version: 1,
  },
];

export async function seedSystemValidators(tenantId: string): Promise<void> {
  for (const rule of SYSTEM_RULES) {
    await prisma.unifiedRule.upsert({
      where: { key: rule.key },
      update: rule,
      create: { ...rule, tenantId },
    });
  }
  logger.info({ count: SYSTEM_RULES.length, tenantId }, 'Seeded system validators');
}

// Run on startup
seedSystemValidators('default-tenant').catch(err => logger.error({ err }, 'Seed failed'));
```

#### 2.4 Extend Rules Reload Push

```typescript
// packages/bff/src/services/correction-rules/reload.ts

import { RulesReloadPush, UnifiedRule } from '@undrecreaitwins/engine-types';

export async function pushRulesToEngine(tenantId: string): Promise<void> {
  // Fetch system + custom rules
  const systemRules = await prisma.unifiedRule.findMany({
    where: { tenantId, kind: 'system' },
  });

  const customRules = await prisma.unifiedRule.findMany({
    where: { tenantId, kind: 'custom' },
  });

  const allRules = [...systemRules, ...customRules] as UnifiedRule[];

  const push: RulesReloadPush = {
    version: await getNextVersion(tenantId),
    snapshotVersion: `v${Date.now()}`,
    tenantId,
    rules: allRules,
    pushedAt: new Date(),
  };

  // Push to engine via existing channel
  await enginePushChannel.send('rules-reload', push);
}
```

#### 2.5 Update Quality Events Push Handler

```typescript
// packages/bff/src/services/quality-events/push.ts

import { QualityEventPush } from '@undrecreaitwins/engine-types';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function handleQualityEventPush(event: QualityEventPush): Promise<void> {
  await prisma.qualityEvent.create({
    data: {
      ts: event.ts,
      kind: event.kind,
      ruleKey: event.ruleKey,
      verdict: event.verdict,
      detail: event.detail,
      shortCircuitedBy: event.shortCircuitedBy,
      conversationId: event.conversationId,
      messageId: event.messageId,
      latencyMs: event.latencyMs,
      score: event.score,
      sourceLang: event.sourceLang,
      targetLang: event.targetLang,
      originalResponseSnippet: event.originalResponse?.slice(0, 500),
      modifiedResponseSnippet: event.modifiedResponse?.slice(0, 500),
    },
  });
}
```

### Step 3: Backfill Historical Data

#### 3.1 Export `validator_runs` from Engine DB

```bash
# Export to CSV
psql -d engine_db -c "\copy (SELECT * FROM validator_runs WHERE runAt < NOW() - INTERVAL '30 days') TO '/tmp/validator_runs.csv' CSV HEADER"
```

#### 3.2 Transform and Import to BFF

```typescript
// packages/bff/src/scripts/backfill-validator-runs.ts

import { PrismaClient } from '@prisma/client';
import { createReadStream } from 'fs';

const prisma = new PrismaClient();

async function backfill(): Promise<void> {
  const csvStream = createReadStream('/tmp/validator_runs.csv');
  
  // Parse CSV and transform
  for await (const row of parseCsv(csvStream)) {
    await prisma.qualityEvent.create({
      data: {
        ts: new Date(row.runAt),
        kind: 'system',
        ruleKey: mapValidatorTypeToRuleKey(row.validator_type),
        verdict: mapVerdict(row.passed, row.severity),
        conversationId: row.conversation_id,
        messageId: row.message_id,
        latencyMs: parseInt(row.latency_ms),
        originalResponseSnippet: row.response_snippet?.slice(0, 500),
        createdAt: new Date(row.runAt),
      },
    });
  }

  logger.info('Backfill complete');
}

backfill().catch(err => logger.error({ err }, 'Backfill failed'));
```

### Step 4: Verify Integration

#### 4.1 Unit Tests

```bash
# Engine
cd packages/core
npm test -- response-guard.test.ts
npm test -- unified-emitter.test.ts

# BFF
cd packages/bff
npm test -- rules-reload.test.ts
npm test -- quality-events.test.ts
```

#### 4.2 Integration Tests

```bash
# End-to-end: chat-service → response-guard → BFF
npm test -- chat-service.response-guard.integration.test.ts
```

#### 4.3 Regression Tests

```bash
# Ensure parity with existing behavior
npm test -- 004-validators
npm test -- 017-language-guard
npm test -- 018-response-quality-rules
npm test -- 024-language-guard-rewrite-mirror
```

#### 4.4 Performance Tests

```bash
# Verify cost parity (NFR-1)
npm test -- performance.happy-path.test.ts
# Expected: LLM call count = 0 for personas without custom rules
```

### Step 5: Gradual Rollout

#### 5.1 Feature Flag

```typescript
// Use feature flag to switch between old/new pipeline
const USE_RESPONSE_GUARD = process.env.USE_RESPONSE_GUARD === 'true';

if (USE_RESPONSE_GUARD) {
  result = await responseGuard.run(response, ctx);
} else {
  // Old behavior
  result = await legacyPipeline(response, ctx);
}
```

#### 5.2 Rollout Plan

1. **Day 1-2**: Deploy to staging, run full test suite
2. **Day 3-4**: Enable for 10% of tenants (feature flag)
3. **Day 5-6**: Monitor logs, verify cost parity
4. **Day 7**: Enable for 50% of tenants
5. **Day 10**: Enable for 100% of tenants
6. **Day 30**: Remove legacy code paths

## Troubleshooting

### Issue: LLM calls on happy-path

**Symptom**: Cost spike after deployment.

**Diagnosis**:

```bash
# Check rule config
grep '"terminalOnFail": false' unified_rules | grep '"kind": "system"'
```

**Fix**: Ensure `block` validators have `terminalOnFail=true`.

### Issue: Short-circuit not working

**Symptom**: Pipeline continues after `block` verdict.

**Diagnosis**:

```typescript
// Check rule config
const rule = ruleCache.get(ruleKey);
logger.info({ terminalOnFail: rule.terminalOnFail }, 'Rule info:');
```

**Fix**: Verify `terminalOnFail` flag in BFF `unified_rules` table.

### Issue: Events not appearing in BFF

**Symptom**: `quality_events` table empty.

**Diagnosis**:

```bash
# Check engine logs
grep 'QualityEventPush' /var/log/engine.log

# Check BFF push handler
grep 'handleQualityEventPush' /var/log/bff.log
```

**Fix**: Verify push channel connectivity, check BFF push handler registration.

## Next Steps

1. **Product-028**: Update UI to consume unified `quality_events` table (remove normalization adapters)
2. **Monitoring**: Add dashboards for `verdict` distribution, LLM call count, p95 latency
3. **Cleanup** (Day 30+): Drop `validator_runs` table, remove legacy code paths
