# Context for External AI Review: 023-language-guard-validator-leftovers

**Feature**: Language Guard Validator Leftovers — API, Config Fields, Audit Log
**Repo**: `undrecreaitwins` (Engine)
**Date**: 2026-06-19
**Reviewer instruction**: Read this file, then review `spec.md`, `plan.md`, `tasks.md`, `data-model.md`, `contracts/`, `research.md` in `specs/023-language-guard-validator-leftovers/`. Write your verdict to `specs/023-language-guard-validator-leftovers/reviews/<your-provider>.md`.

---

## What This Feature Does

`LanguageGuardValidator` (259 LOC) is **already implemented** as a runtime component. It filters LLM responses by language script (Cyrillic, CJK, etc.) with three verdicts: `pass`, `strip` (remove non-compliant chars), `block` (replace with fallback).

**The problem**: There's no HTTP API to manage its configuration. Product UI (spec 026) needs to:
1. Read/write language-guard config per persona
2. Toggle guard on/off
3. Prevent concurrent config overwrites (optimistic locking)
4. Read audit log history

## What Gets Built

| Component | What |
|-----------|------|
| `GET /v1/personas/:id/validators/language-guard` | Read config + configVersion |
| `PUT /v1/personas/:id/validators/language-guard` | Save config with optimistic locking (`expectedVersion` required) |
| `GET .../logs?limit=20&cursor=...` | Paginated audit log from `validator_runs` table |
| `LanguageGuardConfig` type | Add `enabled: boolean`, `configVersion: number` |
| Pipeline skip | `if (config.enabled === false) return;` before validator call |

## Key Design Decisions

1. **Storage**: Config in existing `validator_configs` table (JSONB `config` column). No schema migration. `enabled` and `configVersion` inside JSONB blob.

2. **Optimistic locking**: `configVersion` is integer counter. PUT requires `expectedVersion` (strict mandatory — 400 if missing). Mismatch → 409 + current config. Increment on success.

3. **Backward compat**: Old configs without `enabled`/`configVersion` → treated as `enabled: true`, `configVersion: 0`.

4. **Audit log**: Reuses existing `validator_runs` table. Compound cursor (`createdAt_id` base64-encoded) for pagination. No new tables.

5. **BCP-47 validation**: Regex `^(?<lang>[a-z]{2,3})(-(?<script>[A-Za-z]{4}))?(-(?<region>[A-Z]{2}|[0-9]{3}))?$` — covers all 9 supported languages.

6. **No new DB tables**. No schema changes. Pure API layer + type extension.

## User Stories

| ID | Story | Priority |
|----|-------|----------|
| US-1 | Read config (GET) | P1 |
| US-2 | Save config (PUT) | P1 |
| US-3 | Enable/disable guard | P1 |
| US-4 | Audit log (GET /logs) | P2 |
| US-5 | Optimistic locking | P1 |

## Contracts Summary

### GET Response
```json
{
  "config": {
    "enabled": true,
    "allowedLanguages": ["en", "ru"],
    "mode": "dry-run",
    "stripThreshold": 0.05,
    "blockThreshold": 0.30,
    "regenerateOnViolation": false
  },
  "configVersion": 3
}
```

### PUT Request
```json
{
  "config": { /* same fields */ },
  "expectedVersion": 2
}
```

### PUT Errors
- 400 `MISSING_EXPECTED_VERSION` — no expectedVersion in body
- 400 `VALIDATION_FAILED` — field-level errors: `{ error, fields: { [field]: string } }`
- 409 `CONFLICT` — version mismatch: `{ error, currentConfig, currentVersion }`

### GET /logs Response
```json
{
  "items": [
    {
      "id": "uuid",
      "verdict": "strip",
      "metadata": { "nonCompliantFraction": 0.12, "detectedScripts": ["Cyrillic"] },
      "createdAt": "2026-06-19T14:30:00.000Z"
    }
  ],
  "nextCursor": "base64..."
}
```

## Files to Review

| File | Why |
|------|-----|
| `spec.md` | Full requirements, user stories, edge cases |
| `plan.md` | Technical context, constitution check, project structure |
| `tasks.md` | 12 tasks with dependency graph and agent routing |
| `data-model.md` | Type definitions, storage schema, validation rules |
| `contracts/` | API contracts (GET-config, PUT-config, GET-logs) |
| `research.md` | Design decisions with alternatives considered |

## What to Check

1. **Consistency**: Do spec, plan, tasks, and contracts agree on endpoints, error formats, and field names?
2. **Completeness**: Are all 8 FRs + 4 NFRs covered by tasks?
3. **Correctness**: Is the compound cursor logic sound? Is the locking mechanism race-condition-free?
4. **Edge cases**: Are the 7 edge cases in spec §6 handled by the implementation plan?
5. **Constitution alignment**: No violations (all 9 principles pass per plan.md).

## What NOT to Review

- `LanguageGuardValidator` runtime (already implemented, out of scope)
- Product UI (spec 026, separate feature)
- Other validators (false-promise, format-injection, identity-guard)
- Database schema (no changes — reusing existing tables)
