# Quickstart: Language Guard Validator Leftovers

**Feature**: 023-language-guard-validator-leftovers
**Date**: 2026-06-19

## Scenario 1: GET default config (never configured)

```bash
# Persona has no language-guard config yet
curl -H "X-Tenant-ID: tenant-abc" \
  http://localhost:3000/v1/personas/persona-123/validators/language-guard

# Expected: 200 with default config
# {
#   "config": {
#     "enabled": true,
#     "allowedLanguages": [],
#     "mode": "dry-run",
#     "stripThreshold": 0.05,
#     "blockThreshold": 0.30,
#     "regenerateOnViolation": false
#   },
#   "configVersion": 0
# }
```

## Scenario 2: PUT initial config (first setup)

```bash
# First configuration — expectedVersion must be 0
curl -X PUT \
  -H "X-Tenant-ID: tenant-abc" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "enabled": true,
      "allowedLanguages": ["en"],
      "mode": "active",
      "stripThreshold": 0.05,
      "blockThreshold": 0.30,
      "regenerateOnViolation": false
    },
    "expectedVersion": 0
  }' \
  http://localhost:3000/v1/personas/persona-123/validators/language-guard

# Expected: 200 with configVersion: 1
```

## Scenario 3: PUT with version conflict

```bash
# Concurrent edit: someone else updated config
curl -X PUT \
  -H "X-Tenant-ID: tenant-abc" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "enabled": true,
      "allowedLanguages": ["en", "ru"],
      "mode": "active",
      "stripThreshold": 0.05,
      "blockThreshold": 0.30,
      "regenerateOnViolation": false
    },
    "expectedVersion": 1
  }' \
  http://localhost:3000/v1/personas/persona-123/validators/language-guard

# Expected: 409 CONFLICT
# {
#   "error": "CONFLICT",
#   "currentConfig": { ... },
#   "currentVersion": 3
# }
```

## Scenario 4: PUT validation error

```bash
# stripThreshold > blockThreshold
curl -X PUT \
  -H "X-Tenant-ID: tenant-abc" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "enabled": true,
      "allowedLanguages": ["en"],
      "mode": "active",
      "stripThreshold": 0.50,
      "blockThreshold": 0.30,
      "regenerateOnViolation": false
    },
    "expectedVersion": 3
  }' \
  http://localhost:3000/v1/personas/persona-123/validators/language-guard

# Expected: 400
# {
#   "error": "VALIDATION_FAILED",
#   "fields": {
#     "stripThreshold": "stripThreshold must be <= blockThreshold"
#   }
# }
```

## Scenario 5: Disable guard

```bash
curl -X PUT \
  -H "X-Tenant-ID: tenant-abc" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "enabled": false,
      "allowedLanguages": ["en"],
      "mode": "active",
      "stripThreshold": 0.05,
      "blockThreshold": 0.30,
      "regenerateOnViolation": false
    },
    "expectedVersion": 3
  }' \
  http://localhost:3000/v1/personas/persona-123/validators/language-guard

# Expected: 200
# Pipeline now skips language-guard entirely for this persona
# No validation, no directive injection, no audit entries
```

## Scenario 6: GET audit logs (first page)

```bash
curl -H "X-Tenant-ID: tenant-abc" \
  "http://localhost:3000/v1/personas/persona-123/validators/language-guard/logs?limit=2"

# Expected: 200
# {
#   "items": [
#     { "id": "...", "verdict": "strip", "metadata": { ... }, "createdAt": "..." },
#     { "id": "...", "verdict": "pass", "metadata": { ... }, "createdAt": "..." }
#   ],
#   "nextCursor": "base64..."
# }
```

## Scenario 7: GET audit logs (second page)

```bash
# Use nextCursor from previous response
curl -H "X-Tenant-ID: tenant-abc" \
  "http://localhost:3000/v1/personas/persona-123/validators/language-guard/logs?limit=2&cursor=<nextCursor>"

# Expected: 200 with more items, or empty items + null nextCursor on last page
```

## Scenario 8: Missing expectedVersion

```bash
curl -X PUT \
  -H "X-Tenant-ID: tenant-abc" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "enabled": true,
      "allowedLanguages": ["en"],
      "mode": "active",
      "stripThreshold": 0.05,
      "blockThreshold": 0.30,
      "regenerateOnViolation": false
    }
  }' \
  http://localhost:3000/v1/personas/persona-123/validators/language-guard

# Expected: 400
# {
#   "error": "MISSING_EXPECTED_VERSION",
#   "message": "expectedVersion is required"
# }
```

## Scenario 9: Audit log for never-active guard

```bash
# Guard was never activated (dry-run only or disabled)
curl -H "X-Tenant-ID: tenant-abc" \
  "http://localhost:3000/v1/personas/persona-456/validators/language-guard/logs"

# Expected: 200
# { "items": [], "nextCursor": null }
```
