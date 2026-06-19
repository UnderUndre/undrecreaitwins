# Contract: PUT /v1/personas/:personaId/validators/language-guard

**Purpose**: Save language-guard configuration with optimistic locking.

## Request

```
PUT /v1/personas/:personaId/validators/language-guard
Headers:
  X-Tenant-Claim: string (preferred, base64url JSON {tenant: <id>} set by BFF)
  X-Tenant-ID: string (fallback if X-Tenant-Claim absent)
  Content-Type: application/json
Body:
{
  "config": {
    "enabled": true,
    "allowedLanguages": ["en", "ru"],
    "mode": "dry-run",
    "stripThreshold": 0.05,
    "blockThreshold": 0.30,
    "fallbackMessage": "I can only respond in English.",
    "regenerateOnViolation": false
  },
  "expectedVersion": 2
}
```

- `expectedVersion` is strictly required — 400 if missing.
- Duplicates in `allowedLanguages` are silently deduped before save.

## Response

### 200 OK

```json
{
  "config": {
    "enabled": true,
    "allowedLanguages": ["en", "ru"],
    "mode": "dry-run",
    "stripThreshold": 0.05,
    "blockThreshold": 0.30,
    "fallbackMessage": "I can only respond in English.",
    "regenerateOnViolation": false
  },
  "configVersion": 3
}
```

`configVersion` is incremented after successful save.

### 400 Bad Request — Missing expectedVersion

```json
{
  "error": "MISSING_EXPECTED_VERSION",
  "message": "expectedVersion is required"
}
```

### 400 Bad Request — Validation failed

```json
{
  "error": "VALIDATION_FAILED",
  "fields": {
    "stripThreshold": "stripThreshold must be <= blockThreshold",
    "allowedLanguages": "Invalid BCP-47 language code: xx-yy"
  }
}
```

Field-level errors allow Product UI to highlight specific form fields. Error codes: `THRESHOLD_ORDER`, `THRESHOLD_RANGE`, `INVALID_BCP47`. All validation errors return `{ error: "VALIDATION_FAILED", fields: { [fieldName]: string } }` format.

### 409 Conflict — Version mismatch

```json
{
  "error": "CONFLICT",
  "currentConfig": {
    "enabled": true,
    "allowedLanguages": ["en"],
    "mode": "active",
    "stripThreshold": 0.05,
    "blockThreshold": 0.30,
    "regenerateOnViolation": false
  },
  "currentVersion": 5
}
```

Client can diff `currentConfig` against attempted config to resolve conflict.

### 404 Not Found

```json
{
  "error": "NOT_FOUND",
  "message": "Persona not found"
}
```

## Validation Rules

| Check | Error Code | Status |
|-------|------------|--------|
| `expectedVersion` missing | `MISSING_EXPECTED_VERSION` | 400 |
| `stripThreshold > blockThreshold` | `THRESHOLD_ORDER` | 400 |
| `blockThreshold` out of range `[0, 1]` | `THRESHOLD_RANGE` | 400 |
| `stripThreshold` out of range `[0, 1]` | `THRESHOLD_RANGE` | 400 |
| `mode: 'active'` + `allowedLanguages` empty | `EMPTY_ACTIVE_LANGUAGES` | 400 |
| Invalid BCP-47 code in `allowedLanguages[*]` | `INVALID_BCP47` | 400 |
| Duplicate entries in `allowedLanguages` | Deduped silently (no error) | N/A |
| `expectedVersion` ≠ current `configVersion` | `CONFLICT` + current config | 409 |
