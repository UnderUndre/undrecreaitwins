# Contract: 018 DAR Pipeline — Cross-Repo + Internal API

## 1. Product → Engine: Rule Pull (HTTP)

### `GET /v1/correction-rules?assistantId=<id>`

**Direction**: Engine calls Product (outbound)

**Auth**: `Authorization: Bearer <TWIN_PRODUCT_API_KEY>` + `X-Tenant-ID: <tenantId>`

**Conditional GET**: Engine sends `If-None-Match: <snapshotVersion>` header (or `?knownVersion=<version>` query param).

**Response (200 OK)**:
```json
{
  "rules": [
    {
      "id": "uuid",
      "tenantId": "uuid",
      "assistantId": "uuid-or-null",
      "name": "Em-dash removal",
      "detector": {
        "type": "regex",
        "config": { "pattern": "—", "flags": "g" }
      },
      "rewriteInstruction": "Replace em-dashes with appropriate punctuation (comma, period, parentheses).",
      "mode": "score",
      "priority": 50,
      "scope": "full",
      "turnScope": null,
      "isEnabled": true,
      "rubricItems": null
    }
  ],
  "snapshotVersion": "etag-or-hash"
}
```

**Response (304 Not Modified)**: cache unchanged, Engine keeps existing entry.

**Response (404)**: assistant has no rules → empty set (Engine treats as no-op).

**Error handling**: Product API unavailable → use cached rules (if fresh) or skip DAR (reply delivered without custom rules). Logged via pino.

---

## 2. Engine → Product: Event Push (HTTP)

### `POST /v1/quality-events`

**Direction**: Engine calls Product (outbound)

**Auth**: `Authorization: Bearer <TWIN_PRODUCT_API_KEY>` + `X-Tenant-ID: <tenantId>`

**Request body**:
```json
{
  "events": [
    {
      "assistantId": "uuid",
      "ruleId": "uuid",
      "ruleName": "Em-dash removal",
      "conversationId": "uuid",
      "messageId": "uuid",
      "mode": "rewrite",
      "verdict": "rewritten",
      "originalText": "Вот — отличный вариант.",
      "rewrittenText": "Вот, отличный вариант.",
      "score": null,
      "latencyMs": 1200,
      "rolledBack": false
    }
  ]
}
```

**Response**: `204 No Content` (success) or `2xx` (idempotent — Product doesn't need to return data).

**Fire-and-forget**: Engine logs errors via pino, does NOT retry, does NOT block reply delivery. Events may be lost on crash (Phase 1 trade-off).

**Fan-out**: Aggregated rewrite rollback (multiple rules in one rewrite pass that fails re-validation) → Engine pushes N events (one per triggered rule), all with `verdict: 'rolled_back'`.

---

## 3. Product → Engine: Cache Invalidation Webhook (HTTP)

### `POST /v1/internal/rules-reload`

**Direction**: Product calls Engine (inbound)

**Auth**: `Authorization: Bearer <TWIN_INTERNAL_WEBHOOK_SECRET>` — **dedicated shared secret**, separate from `TWIN_PRODUCT_API_KEY`. Unauthenticated or invalid → `401 Unauthorized`, cache untouched (closes DoS / cache-poison vector).

**Request body**:
```json
{
  "assistantId": "uuid",
  "tenantId": "uuid"
}
```

**Response**: `204 No Content` (cache entry purged; next reply triggers fresh pull).

**Behavior**: Invalidates the in-memory cache entry for `(tenantId, assistantId)`. Does NOT immediately re-pull — next incoming reply for that assistant triggers the pull. If the assistant wasn't cached, `204` is still returned (idempotent).

---

## 4. Internal Module Contracts (Engine code)

### DARPipeline

```typescript
class DARPipeline {
  constructor(
    ruleCache: RuleCache,
    llm: LLMClient,
    eventPushClient: EventPushClient,
    logger: pino.Logger,
  )

  async execute(
    text: string,
    context: {
      tenantId: string;
      personaId: string;
      conversationId: string;
      messageId?: string;
      rawUserMessage?: string;
    },
  ): Promise<DARResult>
}
```

**Contract**:
- Never throws — wraps all stages in try/catch, returns original text on failure.
- Empty rule set (0 enabled rules) → immediate no-op return (zero LLM calls).
- `DARResult.text` = text to deliver to customer (rewritten or original).
- `DARResult.events` = events to push (async, fire-and-forget via `setImmediate` for score-mode, immediate push for rewrite-mode).

### RuleCache

```typescript
class RuleCache {
  constructor(productClient: ProductClient, logger: pino.Logger)

  async getRules(tenantId: string, assistantId: string): Promise<{ rules: CorrectionRule[]; snapshotVersion: string }>
  invalidate(assistantId: string): void
}
```

**Contract**:
- `getRules`: returns cached if fresh (TTL), else pulls from Product. Conditional GET via `If-None-Match`.
- `invalidate`: purges cache entry (webhook-triggered).
- Pull failure → returns last cached rules if available, else empty array (DAR skips).

### ReValidator

```typescript
class ReValidator {
  constructor(llm: LLMClient)

  async validate(text: string, context: ValidatorContext): Promise<{ passed: boolean; reason?: string }>
}
```

**Contract**:
- Instantiates `FalsePromiseValidator` + `IdentityGuardValidator` directly (004 modules).
- Calls `validateAndMutate()` on each.
- Returns `{ passed: false }` if any validator detects a violation.
- 1 pass, no loop.

---

## 5. Env Var Contract

| Var | Direction | Purpose |
|-----|-----------|---------|
| `TWIN_PRODUCT_API_URL` | Engine → Product | Base URL for pull + push (`http://localhost:3000`). Unset → DAR disabled. |
| `TWIN_PRODUCT_API_KEY` | Engine → Product | Bearer token for outbound calls. |
| `TWIN_INTERNAL_WEBHOOK_SECRET` | Product → Engine | Bearer token for rules-reload route auth. |
| `CORRECTION_RULE_CACHE_TTL_MS` | Internal | Cache TTL (default 60000). |
| `TWIN_DAR_SEMANTIC_CONCURRENCY` | Internal | Max concurrent semantic LLM calls (default 3). |
| `TWIN_DAR_SEMANTIC_TIMEOUT_MS` | Internal | Per-detector LLM timeout (default 5000). |

---

## 6. Error Model

| Error | Where | Handling |
|-------|-------|----------|
| Product API pull fails | `ProductClient.fetch()` | Return last cache if available, else empty. Log warning. DAR skipped. |
| Product API push fails | `EventPushClient.push()` | Log error. Drop events. No retry. Reply not affected. |
| Invalid regex pattern (Engine-side safety) | `RegexDetector.detect()` | try/catch `new RegExp()`. Skip rule, log error. |
| LLM call timeout | `SemanticDetector` / `PatternDetector` | Fail-open (score: skip event), fail-closed (rewrite: skip rule). Log timeout. |
| LLM rewrite returns empty | `Rewriter.rewrite()` | Rollback to original text (same as 004 FR-019). |
| Re-validation fails | `ReValidator.validate()` | Rollback to pre-DAR text. Push `rolled_back` events (fan-out). |
| Webhook auth fails | `correction-rules-reload.ts` route | `401 Unauthorized`. Cache untouched. |
| DAR pipeline catches any error | `DARPipeline.execute()` | Log + return original text + empty events. Reply not blocked. |
