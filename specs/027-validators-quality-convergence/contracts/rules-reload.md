# Contract: Rules Reload (BFF → Engine)

**Feature**: 027-validators-quality-convergence  
**Date**: 2026-06-23  
**Status**: Draft  
**Direction**: BFF → Engine (push channel)

## 1. Overview

Extended version of existing `correction-rules-reload` push. Now carries unified rules (system validators + custom quality rules) from BFF to engine rule-cache.

## 2. Schema

```typescript
// packages/core/src/types/quality.ts

export interface RulesReloadPush {
  version: number;                  // Cache version (increments on any rule change)
  snapshotVersion: string;          // Snapshot identifier (e.g., 'v1', 'v2')
  tenantId: string;                 // Tenant context
  rules: UnifiedRule[];             // All rules (system + custom)
  pushedAt: Date;                   // Push timestamp
}

// UnifiedRule (repeated for reference)
export interface UnifiedRule {
  key: string;
  kind: 'system' | 'custom';
  enabled: boolean;
  mode?: string;
  terminalOnFail: boolean;
  priority: number;
  validatorType?: string;           // For system rules
  prompt?: string;                  // For custom rules
  threshold?: number;               // For custom rules
  version: number;
  updatedAt: Date;
}
```

## 3. Field Specifications

### 3.1 Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | `number` | Monotonically increasing cache version. Engine rejects stale versions. |
| `snapshotVersion` | `string` | Human-readable snapshot (e.g., `v1`, `v2`). For debugging/audit. |
| `tenantId` | `string` | Tenant identifier. Engine caches per-tenant. |
| `rules` | `UnifiedRule[]` | Complete rule set (system + custom). |
| `pushedAt` | `Date` | Push timestamp (UTC). |

### 3.2 UnifiedRule Fields

| Field | Type | Description |
|-------|------|-------------|
| `key` | `string` | Unique rule identifier (e.g., `language-guard`, `custom-123`). |
| `kind` | `'system' \| 'custom'` | Rule type. `system` = built-in validator; `custom` = LLM-based rule. |
| `enabled` | `boolean` | On/off switch. Disabled rules skipped in pipeline. |
| `mode` | `string?` | Validator-specific mode (e.g., `strict`, `lenient`). Optional. |
| `terminalOnFail` | `boolean` | Short-circuit flag. If `true`, pipeline stops on failure. |
| `priority` | `number` | Stage execution order (lower = earlier). Must be unique per tenant. |
| `validatorType` | `string?` | System validator type (`language-guard`, `false-promise`, etc.). |
| `prompt` | `string?` | DAR prompt template (for custom rules). |
| `threshold` | `number?` | Quality score threshold 0-1 (for custom rules). |
| `version` | `number` | Rule version (for fine-grained invalidation). |
| `updatedAt` | `Date` | Last update timestamp. |

## 4. Push Protocol

### 4.1 Trigger Events

BFF pushes `RulesReloadPush` on:

1. **Startup**: Engine connects, BFF sends full rule set
2. **Rule CRUD**: Any rule created/updated/deleted in BFF
3. **Periodic refresh**: Every 5 minutes (configurable) to recover from missed pushes
4. **Manual trigger**: Admin API call to force reload

### 4.2 Push Flow

```
BFF (rule change detected)
  ↓
Build RulesReloadPush payload
  ↓
Increment version
  ↓
Push to engine via existing channel
  ↓
Engine receives
  ├─ Validate schema
  ├─ Check version > current?
  │   ├─ Yes → update rule-cache
  │   └─ No → reject (stale push)
  └─ Ack to BFF
```

### 4.3 Error Handling

| Scenario | BFF Behavior | Engine Behavior |
|----------|-------------|-----------------|
| Engine unavailable | Queue push, retry with backoff (max 3 attempts) | N/A |
| Engine rejects (stale version) | Log warning, increment version, retry | Return 409 Conflict |
| Engine rejects (invalid schema) | Log error, alert ops | Return 400 Bad Request |
| Network timeout | Queue push, retry | N/A |

## 5. Engine Rule-Cache Update

### 5.1 Cache Structure

```typescript
// packages/core/src/services/rule-cache/index.ts

interface RuleCache {
  tenantId: string;
  version: number;
  snapshotVersion: string;
  rules: Map<string, UnifiedRule>;  // key → rule
  priorityIndex: Map<number, UnifiedRule>;  // priority → rule (for ordering)
  loadedAt: Date;
  pushedAt: Date;
}
```

### 5.2 Update Algorithm

```typescript
function updateRuleCache(push: RulesReloadPush): void {
  // 1. Validate version
  if (push.version <= currentCache.version) {
    throw new Error('Stale push: version not incremented');
  }
  
  // fix F9: cache keyed by (tenantId, personaId)
  // fix F11: skip+deadletter malformed rules, don't reject entire push
  
  // 2. Build new indexes
  const rules = new Map<string, UnifiedRule>();
  const priorityIndex = new Map<number, UnifiedRule>();
  const deadletter: Array<{ rule: UnifiedRule; reason: string }> = [];
  
  for (const rule of push.rules) {
    // Validate rule has required fields for its kind
    if (rule.kind === 'custom' && !rule.detector) {
      deadletter.push({ rule, reason: 'Missing detector config (fix F2)' });
      continue;
    }
    
    // Check priority uniqueness — skip duplicate, don't throw (fix F11)
    if (priorityIndex.has(rule.priority)) {
      deadletter.push({ rule, reason: `Duplicate priority ${rule.priority}` });
      continue;
    }
    
    rules.set(rule.key, rule);
    priorityIndex.set(rule.priority, rule);
  }
  
  // Alert on deadlettered rules
  if (deadletter.length > 0) {
    logger.warn({ deadletter, tenantId: push.tenantId }, 'Rules deadlettered during cache update');
  }
  
  // 3. Atomic swap
  currentCache = {
    tenantId: push.tenantId,
    version: push.version,
    snapshotVersion: push.snapshotVersion,
    rules,
    priorityIndex,
    loadedAt: new Date(),
    pushedAt: push.pushedAt,
  };
}
```

### 5.3 Cache Invalidation

| Event | Action |
|-------|--------|
| New push received | Update cache (if version > current) |
| Cache expiry (5 min) | Trigger BFF push request |
| Engine restart | Clear cache, wait for BFF startup push |
| Stale push (version ≤ current) | Reject, log warning |

## 6. System Validator Seeding

### 6.1 Seed Strategy

BFF seeds system validators on:

1. **Database migration**: Initial `unified_rules` table creation
2. **Engine registration**: New validator class added to engine
3. **Manual trigger**: Admin API call

### 6.2 Seed Payload

```typescript
const SYSTEM_RULES: UnifiedRule[] = [
  {
    key: 'language-guard',
    kind: 'system',
    enabled: true,
    mode: 'standard',
    terminalOnFail: true,
    priority: 1,
    validatorType: 'language-guard',
    version: 1,
    updatedAt: new Date(),
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
    updatedAt: new Date(),
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
    updatedAt: new Date(),
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
    updatedAt: new Date(),
  },
];
```

**Idempotency**: BFF uses `upsert` (update if exists, create if not). Safe to re-run.

### 6.3 System Rule Constraints

| Constraint | Enforcement |
|------------|-------------|
| Non-removable | BFF API rejects DELETE for `kind='system'` |
| Non-duplicable | BFF API rejects CREATE if `key` already exists (even for system) |
| Priority uniqueness | BFF validates no duplicate `priority` per tenant |
| Enabled by default | Seed sets `enabled=true` |

## 7. Backward Compatibility

### 7.1 Legacy Push Format (Pre-027)

**Old format** (`correction-rules-reload`):

```typescript
interface LegacyRulesReload {
  version: number;
  rules: CorrectionRule[];  // Only custom rules
}
```

**Compatibility layer** (BFF):

```typescript
function transformLegacyToUnified(legacy: LegacyRulesReload): RulesReloadPush {
  return {
    version: legacy.version,
    snapshotVersion: `legacy-${legacy.version}`,
    tenantId: getCurrentTenant(),
    rules: [
      ...SYSTEM_RULES,  // Inject system rules
      ...legacy.rules.map(r => ({ ...r, kind: 'custom' as const })),
    ],
    pushedAt: new Date(),
  };
}
```

**Deprecation**: Engine accepts both formats for 90 days, logs warning for legacy format.

### 7.2 Engine `validator_configs` (026)

**Status**: Deprecated, becomes cache/projection.

**Migration**:

1. BFF seeds system rules to `unified_rules` (kind='system')
2. Engine `validator_configs` populated from `unified_rules` (read-only projection)
3. After 90 days: engine `validator_configs` table dropped

## 8. Validation

### 8.1 Schema Validation (BFF)

```typescript
const RulesReloadPushSchema = z.object({
  version: z.number().int().positive(),
  snapshotVersion: z.string().min(1),
  tenantId: z.string().uuid(),
  rules: z.array(UnifiedRuleSchema).min(1),
  pushedAt: z.coerce.date(),
});

const UnifiedRuleSchema = z.object({
  key: z.string().min(1).max(100),
  kind: z.enum(['system', 'custom']),
  enabled: z.boolean(),
  mode: z.string().max(50).optional(),
  terminalOnFail: z.boolean(),
  priority: z.number().int().min(0).max(1000),
  validatorType: z.string().optional(),
  prompt: z.string().max(10000).optional(),
  threshold: z.number().min(0).max(1).optional(),
  version: z.number().int().positive(),
  updatedAt: z.coerce.date(),
});
```

### 8.2 Contract Tests

- **Test 1**: BFF pushes system+custom rules, engine caches correctly
- **Test 2**: Stale version rejected (409)
- **Test 3**: Duplicate priority rejected (400)
- **Test 4**: System rules non-removable via API (403)
- **Test 5**: Legacy format accepted with warning (deprecation)
- **Test 6**: Periodic refresh (5 min) recovers from missed pushes
- **Test 7**: Engine restart triggers full reload from BFF

## 9. API Endpoints (BFF)

### 9.1 Push Endpoint

```http
POST /api/v1/engine/rules-reload
Content-Type: application/json
Authorization: Bearer <engine-service-token>

{
  "version": 42,
  "snapshotVersion": "v42",
  "tenantId": "tenant-123",
  "rules": [...],
  "pushedAt": "2026-06-23T10:00:00Z"
}
```

**Response**:

- `200 OK` — Cache updated
- `409 Conflict` — Stale version
- `400 Bad Request` — Invalid schema

### 9.2 Admin Endpoints

```http
# Force reload (manual trigger)
POST /api/v1/admin/rules/reload
Authorization: Bearer <admin-token>

# Get current rules
GET /api/v1/admin/rules?tenantId=tenant-123
Authorization: Bearer <admin-token>

# Seed system validators
POST /api/v1/admin/rules/seed-system
Authorization: Bearer <admin-token>
