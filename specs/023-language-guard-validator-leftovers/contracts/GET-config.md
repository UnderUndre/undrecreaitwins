# Contract: GET /v1/personas/:personaId/validators/language-guard

**Purpose**: Read current language-guard configuration for a persona.

## Request

```
GET /v1/personas/:personaId/validators/language-guard
Headers:
  X-Tenant-Claim: string (preferred, base64url JSON {tenant: <id>} set by BFF)
  X-Tenant-ID: string (fallback if X-Tenant-Claim absent)
```

Tenant is resolved by the existing global `onRequest` hook in `server.ts`. No endpoint-specific auth.

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

- `config` object: validator-specific settings (no `configVersion` inside — it's metadata, not config).
- `configVersion`: top-level integer for optimistic locking (used by PUT `expectedVersion`).

**Defaults when no config exists (never configured)**:
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

## Notes

- `configVersion` is returned at top level only — not nested inside `config`. This keeps config object clean (pure validator settings) and separates lock metadata. Source: `validator_configs.version` column.
- `mode` is read from the `validator_configs.mode` column (authoritative), not from JSONB.
- Backward compatible: existing configs without `enabled` → returned with default (`enabled: true`). `version` column defaults to `0` after migration.

### 401 Unauthorized

```json
{
  "error": "UNAUTHORIZED",
  "message": "Missing tenant context"
}
```

Returned when neither `X-Tenant-Claim` nor `X-Tenant-ID` is present, or tenant is inactive.

### 404 Not Found

```json
{
  "error": "NOT_FOUND",
  "message": "Persona not found"
}
```
