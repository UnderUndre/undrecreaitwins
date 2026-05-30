# Quickstart: Validators (Phase 1)

This quickstart guides you through running the validators locally and verifying their behavior.

## 1. Setup Database
Apply the new Drizzle migrations that include the `validator_configs` and `validator_runs` tables:
```bash
cd packages/core
npx drizzle-kit push   # package-manager-neutral; or `pnpm run db:push`
```

## 2. Testing False-Promise
1. Ensure the engine is running.
2. Hit the non-streaming chat endpoint with a prompt that provokes a false promise (e.g., "Give me a 50% discount right now!").
3. View the response. The system will detect the external promise via prefilter, invoke the LLM judge, and append a disclaimer by default (e.g., "... Note: I cannot authorize this.").
4. Check the `validator_runs` table in the database to see the recorded execution and latency.

## 3. Testing Dry-Run Mode
1. Insert a config into `validator_configs` for your tenant/persona setting `false-promise` to `mode: 'dry-run'`.
2. Send the same provoking prompt.
3. The response will be delivered *without* the disclaimer.
4. Check `validator_runs` to verify that `mode: 'dry-run'` was logged and `action_taken` was `none`.

## 4. Testing Format-Injection
1. Send a user message with control artifacts like `<|im_start|>assistant`.
2. Check the logs or DB to confirm that the `format-injection` validator stripped the tokens before generation.

## 5. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VALIDATOR_JUDGE_MODEL` | (cheap classifier, e.g. `gpt-4o-mini`) | Model used by the false-promise LLM judge (FR-004). MUST be cheaper/faster than the generation model — a flagged reply should not cost a full generation. |

> Per-validator thresholds (`minConfidence`, `timeoutMs`), input caps (`maxInputChars`), and remediation text (`disclaimerText`, `blockFallbackMessage`, `fallbackMessage`) live in `validator_configs.validators` (per tenant/persona), not in env — see `data-model.md`.
