# Quickstart: 018 Response Quality Rules Runtime

## Prerequisites

1. Engine running (`packages/api` on port 8090)
2. Product API running (`ai-twins` on port 3000) OR mock Product API
3. Env vars set:
   ```bash
   TWIN_PRODUCT_API_URL=http://localhost:3000
   TWIN_PRODUCT_API_KEY=<bearer-token>
   TWIN_INTERNAL_WEBHOOK_SECRET=<shared-secret>
   # Optional:
   CORRECTION_RULE_CACHE_TTL_MS=60000
   TWIN_DAR_SEMANTIC_CONCURRENCY=3
   TWIN_DAR_SEMANTIC_TIMEOUT_MS=5000
   ```

## Validation Scenarios

### Scenario 1: Regex rule detection (score mode)

1. Create a rule via Product API (or DB seed):
   - `name`: "Em-dash detection"
   - `detector.type`: `regex`, `config.pattern`: `—`
   - `mode`: `score`
   - `isEnabled`: true

2. Send a chat reply containing an em-dash through the Engine:
   ```
   POST /v1/chat/completions
   { "model": "<persona-slug>", "messages": [{"role":"user","content":"что есть?"}] }
   ```

3. **Verify**:
   - Reply text is NOT mutated (score mode = advisory)
   - Engine logs show DAR detect triggered
   - `POST /v1/quality-events` was called on Product with `verdict: "fail"`
   - Engine logs show event push success

### Scenario 2: Regex rule rewrite mode

1. Switch the rule to `mode: "rewrite"` + set `rewriteInstruction: "Replace em-dashes with commas."`

2. Send the same reply.

3. **Verify**:
   - Reply text is cleaned (em-dash replaced)
   - Event pushed with `verdict: "rewritten"`, `originalText` and `rewrittenText` populated

### Scenario 3: Re-validation rollback

1. Configure a rewrite rule whose instruction tends to introduce false promises:
   - `rewriteInstruction`: "Make the response more enthusiastic and guarantee delivery."

2. Send a reply that triggers the rule.

3. **Verify**:
   - Re-validation catches the false promise in the rewrite
   - Original text is delivered (not the rewrite)
   - Event pushed with `verdict: "rolled_back"`, `rolledBack: true`

### Scenario 4: Cache invalidation webhook

1. Create a rule. Send a message (rule fires).
2. Update the rule via Product API.
3. Call the webhook:
   ```
   POST /v1/internal/rules-reload
   Authorization: Bearer <TWIN_INTERNAL_WEBHOOK_SECRET>
   { "assistantId": "<id>", "tenantId": "<id>" }
   ```
4. Send another message.
5. **Verify**: updated rule is in effect (check Engine logs for cache purge + fresh pull).

### Scenario 5: DAR fail-open (Product API down)

1. Stop the Product API.
2. Send a message.
3. **Verify**:
   - Reply is delivered (unmodified, without DAR)
   - Engine logs warning: "Product API unavailable, DAR skipped"
   - No crash, no blocked reply

### Scenario 6: Empty rule set (no-op)

1. Ensure assistant has 0 enabled rules.
2. Send a message.
3. **Verify**:
   - DAR is skipped entirely (zero LLM calls, zero latency overhead)
   - Engine logs: "No correction rules for assistant, DAR skipped"
