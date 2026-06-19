# Research: Language Guard Validator Leftovers

**Date**: 2026-06-19 | **Feature**: 023-language-guard-validator-leftovers

## R-001: Config storage approach

**Decision**: Store language-guard config in existing `validator_configs` table. All fields including `enabled` and `configVersion` stored inside the JSONB `config` column. No schema migration needed.

**Rationale**: Engine already has per-(tenant, persona, validatorName) config storage. Adding a new table for one validator would break the established pattern. JSONB blob allows validator-specific fields without schema migration for each new field. The pipeline resolves config per-request via `resolveConfig()` which already parses JSONB — adding `enabled`/`configVersion` to the same blob is consistent with how `mode` is stored (separate DB column) vs. validator-specific settings (JSONB).

**Alternatives considered**:
- New `language_guard_configs` table → Rejected: breaks the uniform `validator_configs` pattern, requires separate CRUD logic per validator.
- Store `enabled`/`configVersion` as top-level DB columns → Rejected: would require ALTER TABLE for each new field across all validators. JSONB keeps validator-specific fields together without schema churn.

## R-002: Pipeline enabled skip mechanism

**Decision**: Add `if (config.enabled === false) return;` check in `pipeline.ts` before calling `validator.validateAndMutate()`. Missing `enabled` field → treated as `true` (backward compat).

**Rationale**: Simplest possible skip. The pipeline already has skip logic for empty `allowedLanguages` at line 73-77. `enabled: false` means "don't run this validator at all" — no directive injection, no validation, no audit.

**Alternatives considered**:
- Use existing `mode: 'dry-run'` as enable/disable → Rejected: `dry-run` still runs the validator (just doesn't mutate text). `enabled: false` means "skip entirely" — different semantics. Product spec 026 FR-014 requires explicit toggle.
- New `status: 'enabled' | 'disabled'` field → Rejected: adds confusion alongside `mode`. Single boolean is cleaner.

## R-003: Optimistic locking via integer counter

**Decision**: `configVersion: number` stored alongside config in `validator_configs`. Incremented on each PUT. GET returns current version. PUT requires `expectedVersion` (strict mandatory) — 400 if missing, 409 on mismatch.

**Rationale**: Integer counter is simpler than ETag/hash. No collision risk at practical scale. Product 026 FR-012 specifies integer counter.

**Alternatives considered**:
- ETag/hash-based → Rejected: more complex, requires hash computation, no advantage for single-writer-per-tenant scenario.
- Database-level `UPDATE ... WHERE version = $1` → Not needed: Drizzle ORM handles this at application level. DB doesn't need version column — it's an application-level concern stored in JSONB or alongside.

## R-004: Audit log compound cursor

**Decision**: Cursor = base64-encoded `{createdAt}_{id}`. Decode → filter `WHERE createdAt < $1 OR (createdAt = $1 AND id < $2)` for DESC ordering. Use `validator_runs` table filtered by `validatorName: 'language-guard'`.

**Rationale**: Compound cursor prevents duplicates when two logs share the same `createdAt` timestamp. Deterministic ordering guaranteed by `(createdAt DESC, id DESC)` index.

**Alternatives considered**:
- Offset-based pagination → Rejected: slow on large tables, can skip/duplicate rows under concurrent writes.
- Simple cursor on `id` alone → Rejected: doesn't guarantee ordering if IDs are UUIDs (not sequential). Need timestamp for time-based ordering.

## R-005: BCP-47 validation regex

**Decision**: Use regex `^(?<lang>[a-z]{2,3})(-(?<script>[A-Za-z]{4}))?(-(?<region>[A-Z]{2}|[0-9]{3}))?$` for BCP-47 basic validation. This covers the most common cases (e.g., `en`, `en-US`, `zh-Hans-CN`). Full BCP-47 validation is overly complex for this use case.

**Rationale**: Covers all 9 supported languages listed in the config type (`ru`, `en`, `zh`, `ar`, `hi`, `he`, `th`, `ko`, `ja`). The spec says "regex check" — this is sufficient.

**Alternatives considered**:
- `Intl.DisplayNames` API for full validation → Rejected: Node.js `Intl` doesn't expose BCP-47 parser. Would need external library (`@physton/bcp47`).
- No validation (trust the client) → Rejected: FR-005 requires 400 on invalid BCP-47 codes.

## R-006: Default config values

**Decision**: When persona has no language-guard config (never configured), GET returns:
```json
{
  "config": {
    "enabled": true,
    "allowedLanguages": [],
    "mode": "dry-run",
    "stripThreshold": 0.05,
    "blockThreshold": 0.30,
    "regenerateOnViolation": false
  },
  "configVersion": 0
}
```

**Rationale**: Matches spec §6 edge case. `mode: 'dry-run'` is the existing default for language-guard (pipeline.ts line ~150). `enabled: true` ensures backward compat — old configs without field are treated as enabled.

**Alternatives considered**:
- Return 404 if no config → Rejected: spec says "Config может быть пустым (default)" and explicitly lists defaults in §6.
- Return empty config `{}` → Rejected:客户端需要知道 defaults. Better to return fully-formed config with defaults.
