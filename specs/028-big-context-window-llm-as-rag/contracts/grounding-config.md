# Contract: Grounding Configuration API

This contract outlines the changes to the Persona and Tenant API to support configuration of the Big Context Window grounding mode.

## 1. Persona Configuration

### Endpoints:
- `POST /v1/personas` (Create Persona)
- `PATCH /v1/personas/:id` (Update Persona)
- `GET /v1/personas/:id` (Get Persona)

### Request / Response Payloads (JSON)

We extend the schema of `personas` to include:
- `grounding_mode`: `'vector' | 'big-context' | null`
- `big_context_max_tokens`: `integer | null`
- `truncation_strategy`: `'silent' | 'fallback-vector'`

#### POST/PATCH Request Schema Additions (Zod):
```typescript
const updatePersonaSchema = z.object({
  // Existing fields...
  grounding_mode: z.enum(['vector', 'big-context']).nullable().optional(),
  big_context_max_tokens: z.number().int().min(1).nullable().optional(),
  truncation_strategy: z.enum(['silent', 'fallback-vector']).optional(),
});
```

#### API Response Extensions:
```json
{
  "id": "persona-123",
  "tenant_id": "tenant-abc",
  "name": "Assistant",
  "slug": "assistant-slug",
  "system_prompt": "...",
  "grounding_mode": "big-context",
  "big_context_max_tokens": 120000,
  "truncation_strategy": "silent",
  "created_at": "2026-06-25T12:00:00.000Z",
  "updated_at": "2026-06-25T12:00:00.000Z",
  "version": 1
}
```

---

## 2. Tenant Configuration

Tenant-level defaults are configured via tenant administrative endpoints (typically managed cross-repo or via platform admin routes).

### Endpoints:
- `GET /v1/tenants/current`
- `PATCH /v1/tenants/current`

### Payload Additions:
```json
{
  "id": "tenant-abc",
  "name": "Acme Corp",
  "grounding_mode": "vector"
}
```

---

## 3. Documents Configuration

We extend document retrieval metadata to accept custom document-level `priority` values.

### Endpoints:
- `PATCH /v1/documents/:id` (Update Document Metadata)
- `GET /v1/documents` (List Documents)

### Request / Response Payloads:
```json
{
  "id": "doc-456",
  "filename": "price_list.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 10240,
  "status": "ready",
  "priority": 10
}
```
Updating `priority` allows operators to prioritize critical documents (e.g. price lists) to survive context budget truncation.
