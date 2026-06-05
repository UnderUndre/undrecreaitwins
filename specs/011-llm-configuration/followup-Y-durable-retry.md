# Follow-up Y — Durable-retry delivery (US2 completion)

**Status**: DEFERRED follow-up (separate task) · split out of 011 on 2026-06-04
**Parent**: `specs/011-llm-configuration` (engine) · US2 / FR-010 / NFR-8 / DD-HXL-003
**Blocks**: nothing in 011 MVP. 011 ships on the **verified** injection core (US1) without this.

## Why this is a separate task (the gap that was found)

The shipped `provider-retry.worker.ts` compiles and looks like US2, but it is **architecturally incomplete** — it can retry, but it **cannot deliver**:

1. `enqueueProviderRetry` has **zero callers** — nothing enqueues on a provider failure.
2. `ProviderRetryWorker` is **never started** — no `start()` in `packages/api/src/server.ts`.
3. `worker.on('completed')` **only logs** the answer — no outbound delivery.
4. `RetryJobPayload` and `RunAgentTurnInput` carry **no `conversationId`/channel** — there is nowhere to send a late answer even if delivery existed.
5. `RunAgentTurnResult` has **no "queued" state** — the caller can't be told "don't reply now."

**Regression trap**: wiring (1) enqueue without (3)+(4) delivery would turn the current 010 behavior (provider down → thin-completion fallback → *degraded answer now*) into *no answer ever* (worker logs the answer and drops it). That is strictly worse — which is why enqueue was NOT wired.

## What's already DONE (do not redo)

- **Injection** (US1) — verified end-to-end (gate T003 PASSED 2026-06-04): per-assistant BYOK provider reaches Hermes via HERMES_HOME profile + `config.yaml` + `OPENAI_API_KEY`. `hermes-adapter.ts` / `hermes-executor.ts` clean.
- Worker **logic** (backoff classification, dead-letter queue, per-attempt re-resolve + re-decrypt + SSRF re-check) exists in `provider-retry.worker.ts` — reuse it; it just needs wiring + delivery.

## Scope of Y (to make US2 actually work, per DD-HXL-003)

1. **Delivery context** — add `conversationId` + channel/delivery descriptor to `RunAgentTurnInput` and `RetryJobPayload`; thread it from the prod reply-path callers (chat-service / channel intake).
2. **Sandbox flag** — add `isTestThread` (or equivalent) to `RunAgentTurnInput` so the executor can tell prod from sandbox (sandbox = synchronous error, **no** enqueue).
3. **"Queued" result contract** — extend `RunAgentTurnResult` (e.g. `status: 'answered' | 'queued'`); the caller MUST NOT send an immediate reply when `queued`.
4. **Worker delivery-on-success** — `worker.on('completed')` re-enters the engine **outbound channel-send** path (deliver the retried answer to `conversationId` via the messaging gateway). This is the load-bearing missing piece.
5. **Enqueue (A2)** — `hermes-executor.ts` catch: `if (BYOK config && isRetryableProviderError(err) && prod path) → enqueueProviderRetry(...) + return queued; else → existing 010 thin-completion fallback`.
6. **Start (A1)** — `packages/api/src/server.ts` `start()`: `new ProviderRetryWorker().start()`; stop on SIGTERM.
7. **Backoff-cap (A3)** — `cappedBackoff` is computed-but-unused; replace BullMQ's uncapped `exponential` with a custom `backoffStrategy` that honors `MAX_BACKOFF_MS` + `BACKOFF_MULTIPLIER`.
8. **Product status surface** — `ai-twins/011` T009/T010 `RetryStatusBanner` becomes real only after this (queued/dead-letter counts). Until then it has nothing to show.

## Acceptance (Y done when)

- Break a configured BYOK provider on the prod path → message **enqueued**, retried on the same provider, and on recovery the answer is **delivered to the original conversation** (not just logged).
- Window exhausted → dead-letter + operator alert; no silent drop, no thin-completion model-swap.
- Sandbox path on provider failure → synchronous typed error (no enqueue).
- No regression vs current 010 fallback during the transition.

## Files (Y)

`hermes-executor.ts` (input type + catch), `provider-retry.worker.ts` (delivery + cap), `packages/api/src/server.ts` (start), the prod reply-path caller(s) (thread conversationId + sandbox flag + handle `queued`), `ai-twins/011` BFF status + `RetryStatusBanner`.
