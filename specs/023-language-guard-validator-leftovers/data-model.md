# Data Model: Language Guard Validator Leftovers

**Date**: 2026-06-19 | **Feature**: 023-language-guard-validator-leftovers

## 1. Extended Entity: LanguageGuardConfig

**Location**: `packages/core/src/types/validator.ts`

Extends `BaseValidatorConfig` with two new fields:

```typescript
export type ValidatorMode = 'active' | 'dry-run';

export interface LanguageGuardConfig extends BaseValidatorConfig {
  // Existing fields
  allowedLanguages: string[];          // BCP-47 codes: 'ru', 'en', 'zh', 'ar', 'hi', 'he', 'th', 'ko', 'ja'
  stripThreshold: number;              // default 0.05 — non-compliant fraction below this = pass; range [0, 1]
  blockThreshold: number;              // default 0.30 — non-compliant fraction at/above this = block; range [0, 1]
  fallbackMessage?: string;            // custom block fallback
  regenerateOnViolation: boolean;      // flag (currently unused in validator logic)
  mode: ValidatorMode;                 // 'active' = runs + mutates text; 'dry-run' = runs + records, no mutation
                                       //   ⚠ stored in DB COLUMN validator_configs.mode, NOT in JSONB

  // NEW fields (this feature)
  enabled: boolean;                    // toggle: false = pipeline skips entirely
}

// Response wrapper (GET/PUT) — configVersion comes from the DB column, not the JSONB blob
export interface LanguageGuardConfigResponse {
  config: LanguageGuardConfig;
  configVersion: number;               // ← read from validator_configs.version column (atomic lock)
}
```

**Defaults** (when config is missing or empty):
- `enabled: true` — backward compat (old configs without field = enabled)
- `configVersion: 0` — starting version
- `allowedLanguages: []` — no languages configured
- `mode: 'dry-run'` — pipeline default for language-guard
- `stripThreshold: 0.05`
- `blockThreshold: 0.30`
- `regenerateOnViolation: false`

## 2. Storage: validator_configs Table

**Schema addition**: new `version INTEGER NOT NULL DEFAULT 0` column for atomic optimistic locking:

```sql
-- ALTER TABLE (one-time migration)
ALTER TABLE validator_configs
  ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_validator_configs_version
  ON validator_configs (tenant_id, persona_id, validator_name, version);
```

**JSONB `config` column contents for language-guard**:
```json
{
  "allowedLanguages": ["en", "ru"],
  "stripThreshold": 0.05,
  "blockThreshold": 0.30,
  "fallbackMessage": "I can only respond in English.",
  "regenerateOnViolation": false,
  "enabled": true
}
```

> **Source-of-truth for `mode`**: the `validator_configs.mode` column (`validator_mode` enum). NOT stored inside JSONB. GET/PUT read/write `mode` from/to the column directly. The pipeline (`pipeline.ts:188-189`) already reads `row.mode` as authoritative.
>
> **Source-of-truth for `configVersion`**: the `version` DB column. The JSONB `configVersion` field is removed. GET returns the column value. PUT uses `UPDATE ... WHERE version = $expectedVersion` — a single atomic statement that eliminates TOCTOU races.

## 3. Storage: validator_runs Table (Audit Log)

**No schema change.** Existing table already captures language-guard results:

```sql
-- Existing table (unchanged)
CREATE TABLE validator_runs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  conversation_id UUID NOT NULL,
  message_id UUID,
  validator_name TEXT NOT NULL,         -- 'language-guard'
  verdict TEXT NOT NULL,                -- 'pass', 'strip', 'block', 'no_op'
  confidence DOUBLE PRECISION,
  matched_patterns JSONB DEFAULT '[]',
  original_content TEXT,
  remediated_content TEXT,
  latency_ms INTEGER,
  is_dry_run BOOLEAN DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
-- Indexes: (tenant_id, persona_id), (conversation_id), (tenant_id, created_at)
```

**Column → API field mapping** (for `GET /logs` response):

| DB column | API field (in `metadata`) | Notes |
|-----------|---------------------------|-------|
| `confidence` | `nonCompliantFraction` | Double in `[0.0, 1.0]`. Source: `pipeline.ts:217` persists `fraction` into `confidence`. |
| `matched_patterns` | `detectedScripts` | JSONB array of `{ language, confidence }` objects. Source: `pipeline.ts:218`. |
| `verdict` | `verdict` (top-level) | `'pass' \| 'strip' \| 'block' \| 'no_op'` |
| `created_at` | `createdAt` (top-level) | ISO 8601 timestamp |
| `id` | `id` (top-level) | UUID |

> **Privacy**: `original_content` and `remediated_content` are **NOT** exposed via `GET /logs`. The query projects only the columns above (see §Audit log read query).

**Audit log read query** (column projection — no `SELECT *`):
```sql
SELECT id, verdict, confidence, matched_patterns, created_at
FROM validator_runs
WHERE tenant_id = $1
  AND persona_id = $2
  AND validator_name = 'language-guard'
ORDER BY created_at DESC, id DESC
LIMIT $3;
```

**Compound cursor filter** (for pagination):
```sql
-- After decoding cursor = base64("2026-06-19T10:30:00Z_uuid-value")
SELECT id, verdict, confidence, matched_patterns, created_at
FROM validator_runs
WHERE tenant_id = $1
  AND persona_id = $2
  AND validator_name = 'language-guard'
  AND (created_at < $3 OR (created_at = $3 AND id < $4))
ORDER BY created_at DESC, id DESC
LIMIT $5;
```

## 4. State Transitions

### Config Version Lifecycle (atomic UPSERT)

```
[never configured] --PUT(expectedVersion=0)--> [version=1]  (INSERT ... ON CONFLICT DO UPDATE)
[version=N] --PUT(expectedVersion=N)--> [version=N+1]      (UPDATE ... WHERE version=N)
[version=N] --PUT(expectedVersion=M, M≠N)--> 409 CONFLICT   (affected rows = 0)
```

**Atomic write pattern** (single statement, no TOCTOU):

```sql
-- UPSERT: handles both first-write and update atomically
INSERT INTO validator_configs (tenant_id, persona_id, validator_name, mode, config, version, updated_at)
VALUES ($1, $2, 'language-guard', $3, $4::jsonb, 1, now())
ON CONFLICT (tenant_id, persona_id, validator_name)
DO UPDATE SET
  config   = EXCLUDED.config,
  mode     = EXCLUDED.mode,
  version  = validator_configs.version + 1,
  updated_at = now()
WHERE validator_configs.version = $expectedVersion
RETURNING version;
```

If `RETURNING` yields a row → 200 (new version). If no row returned (affected = 0) → 409 CONFLICT.
This single statement eliminates: (a) TOCTOU between read and write, (b) first-write INSERT race.

### Enabled Toggle Behavior

```
enabled=true  → pipeline: runs validator, records audit, mutates text (if mode=active)
                chat-service.ts: injects language directive into system prompt (if allowedLanguages non-empty)
enabled=false → pipeline: skips entirely, no audit, no validation
                chat-service.ts: skips directive injection (no directive in system prompt)
```

## 5. Validation Rules

| Field | Rule | Error Code |
|-------|------|------------|
| `expectedVersion` | Required on all PUT requests (even first setup) | `MISSING_EXPECTED_VERSION` → 400 |
| `stripThreshold` | Must be ≤ `blockThreshold` | `THRESHOLD_ORDER` → 400 |
| `stripThreshold`, `blockThreshold` | Must be in range `[0, 1]` inclusive | `THRESHOLD_RANGE` → 400 |
| `mode` + `allowedLanguages` | If `mode === 'active'` then `allowedLanguages` must not be empty | `EMPTY_ACTIVE_LANGUAGES` → 400 |
| `allowedLanguages[*]` | Must be valid BCP-47 code (regex check) | `INVALID_BCP47` → 400 |
| `allowedLanguages` duplicates | Silently deduped before save (no error) | N/A |
| `enabled` | Boolean | Type error → 400 |
| `configVersion` on GET | Returned as integer (read from `version` column) | N/A (read-only) |

## 6. Edge Cases

- **configVersion overflow**: Practically unreachable (2^53 increments). If hit, hard cap at `Number.MAX_SAFE_INTEGER` — further PUTs return 409 with `currentVersion: Number.MAX_SAFE_INTEGER`. No BigInt needed.
- **Concurrent PUT**: `ON CONFLICT DO UPDATE ... WHERE version = $expected` is atomic — only one request wins the CAS, second sees affected-rows=0 → 409. Client retries with fresh GET.
- **Concurrent first-write**: `INSERT ... ON CONFLICT` handles this atomically — no raw unique-constraint violation leaks to the client.
- **enabled: false + mode: 'active'**: Valid — `enabled=false` overrides mode entirely; pipeline skips before mode check.
