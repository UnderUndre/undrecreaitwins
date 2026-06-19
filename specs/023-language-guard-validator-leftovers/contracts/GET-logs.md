# Contract: GET /v1/personas/:personaId/validators/language-guard/logs

**Purpose**: Read audit log history for language-guard validation events.

## Request

```
GET /v1/personas/:personaId/validators/language-guard/logs?limit=20&cursor=...
Headers:
  X-Tenant-Claim: string (preferred, base64url JSON {tenant: <id>} set by BFF)
  X-Tenant-ID: string (fallback if X-Tenant-Claim absent)
Query Params:
  limit: number (default 20, max 100)
  cursor: string (optional, base64-encoded compound cursor)
```

**Cursor format**: Base64-encoded `{createdAt}_{id}` of the last item from previous page.

## Response

### 200 OK

```json
{
  "items": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "verdict": "strip",
      "metadata": {
        "nonCompliantFraction": 0.12,
        "detectedScripts": ["Cyrillic"]
      },
      "createdAt": "2026-06-19T14:30:00.000Z"
    },
    {
      "id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "verdict": "pass",
      "metadata": {
        "nonCompliantFraction": 0.0,
        "detectedScripts": []
      },
      "createdAt": "2026-06-19T14:25:00.000Z"
    }
  ],
  "nextCursor": "MjAyNi0wNi0xOVQxNDoyNTowMF82YmE3YjgxMC05ZGFkLTExZDEtODBiNC0wMGMwNGZkNDMwYzg="
}
```

- `nextCursor`: `null` when no more pages (last page reached).
- `items`: Empty array `[]` if no audit logs exist for this persona's language-guard.
- `metadata`: Nested structure matching `validator_runs` table schema.

### 404 Not Found

```json
{
  "error": "NOT_FOUND",
  "message": "Persona not found"
}
```

## Notes

- Query is scoped to `tenant_id` (from existing global auth hook in `server.ts`, priority: `X-Tenant-Claim`, fallback `X-Tenant-ID`). Missing/inactive tenant → 401.
- `limit < 1` → 400. Malformed/invalid cursor → 400 `{ error: 'INVALID_CURSOR', message: 'Malformed cursor' }`.

### 400 Bad Request

```json
{
  "error": "INVALID_CURSOR",
  "message": "Malformed cursor"
}
```

Returned when `cursor` query parameter is provided but cannot be decoded (invalid base64 or missing separator).

---

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
