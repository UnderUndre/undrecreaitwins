# Implementation Plan: 018 Response Quality Rules Runtime (DAR Pipeline)

**Branch**: `specs/018-response-quality-rules` | **Date**: 2026-06-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature spec + 004 ValidatorPipeline patterns + 011 LLMClient BYOK resolution + Product contract (ai-twins 019)

## Summary

Dynamic rule execution layer on top of the existing 004 ValidatorPipeline. Operators create custom correction rules in the Product admin UI (ai-twins 019); the Engine pulls them via HTTP per-assistant, caches with TTL + webhook invalidation, and executes a **DAR pipeline** (Detect → Aggregate → Rewrite) on non-streaming replies. Re-validation runs the 004 false-promise + identity-guard validators on the rewrite output; failure → rollback. Quality events are pushed back to Product for the calibration dashboard.

DAR runs AFTER 004 validation (structural safety baseline first), operates on custom operator rules (tone/scope/style), and never blocks reply delivery on failure (fail-open).

## Technical Context

**Language/Version**: TypeScript 5.x, Node 20
**Primary Dependencies**: Fastify (API), Drizzle ORM (PostgreSQL), pino (logging), `ssrfSafeFetch` (outbound HTTP), Langfuse (tracing)
**Storage**: No new Engine DB tables. Rules are external (Product Prisma via HTTP pull). QualityEvents are pushed TO Product (not stored in Engine).
**Testing**: Vitest (unit + integration). Mock LLMClient for detector tests. Mock Product API for cache/push tests.
**Target Platform**: Linux server (Docker, Node 20)
**Project Type**: Monorepo backend service (`packages/core` + `packages/api`)
**Performance Goals**: DAR total latency p95 < 2s (NFR-2). Regex/keyword <1ms. Semantic (LLM) parallelized ≤3 concurrent. Rewrite = 1 LLM call. Re-validation = 1 LLM call (false-promise; identity-guard is regex-only).
**Constraints**: Non-streaming path only (same limitation as 004). Score-mode semantic detectors async (do not block reply). Reply delivery NEVER blocked by DAR failure.
**Scale/Scope**: ~8 new files, ~1200 LOC

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Source of Truth | N/A | Engine runtime feature, not AI config |
| IV. SemVer | N/A | Engine repo, not clai-helpers CLI |
| VI. Cross-AI Review | PENDING | Needs ≥2 external reviewers before implement |
| VII. Artifact Versioning | TODO | Snapshot after plan + tasks generation |

## What Already Exists (Reuse)

| Capability | Status | Key Files |
|---|---|---|
| ValidatorPipeline (004) | IMPLEMENTED | `packages/core/src/services/validators/pipeline.ts` — `validateResponse()` at :30. Returns possibly-mutated reply. |
| False-promise validator | IMPLEMENTED | `packages/core/src/services/validators/false-promise.ts:74` — LLM judge. Can instantiate directly for re-validation. |
| Identity-guard validator | IMPLEMENTED | `packages/core/src/services/validators/identity-guard.ts:22` — regex-only. Instantiable directly. |
| LLMClient with BYOK | IMPLEMENTED | `packages/core/src/services/llm-client.ts:43` — `complete()`. BYOK resolved via `resolveEffectiveConfig()` (:49). |
| Fastify auth middleware | IMPLEMENTED | `packages/api/src/server.ts:118-156` — tenant resolution + token auth `onRequest` hooks. |
| `withTenantContext` | IMPLEMENTED | `packages/core/src/db.ts:18` — RLS via `app.current_tenant` session var. |
| `ssrfSafeFetch` | IMPLEMENTED | `packages/core/src/services/llm-provider/ssrf-audit.ts:29` — DNS-pin + CIDR deny-list for outbound HTTP. |
| Grounding service (pattern ref) | IMPLEMENTED | `packages/core/src/services/grounding/retrieval.ts` — service structure reference. |
| pino logger | IMPLEMENTED | `packages/core/src/services/chat-service.ts` — `logger` used throughout. |
| Langfuse tracing | IMPLEMENTED | `packages/core/src/services/langfuse-service.ts` — fire-and-forget trace spans. |

## What Needs Building (Gap Analysis)

### Stream 1: Types & Interfaces
1. **CorrectionRule types** — `packages/core/src/services/correction-rules/types.ts` — `CorrectionRule`, `DetectorConfig` (discriminated union: regex/keyword/pattern/semantic), `QualityEventPush`, `RuleCacheEntry`, `DARResult`, `verdict` enum (`pass | fail | rewritten | rolled_back | overflow_skipped`)

### Stream 2: Rule Cache (Pull + Invalidation)
2. **Product API client** — `packages/core/src/services/correction-rules/product-client.ts` — `GET <PRODUCT_API_URL>/v1/correction-rules?assistantId=<id>` with Bearer + `X-Tenant-ID`. Conditional GET via `If-None-Match: <snapshotVersion>`. Uses `ssrfSafeFetch`.
3. **Rule cache** — `packages/core/src/services/correction-rules/rule-cache.ts` — in-memory `Map<assistantId, RuleCacheEntry>`. TTL (default 60s, env `CORRECTION_RULE_CACHE_TTL_MS`). `getRules(assistantId, tenantId)` — returns cached or pulls fresh. `invalidate(assistantId)` — webhook-triggered purge.

### Stream 3: DAR Pipeline
4. **Detector implementations** — `packages/core/src/services/correction-rules/detectors/`:
   - `regex-detector.ts` — `new RegExp(pattern, flags).test(text)`. <1ms. Wraps in try/catch for invalid patterns.
   - `keyword-detector.ts` — checks words list (any/all) in text. <1ms.
   - `pattern-detector.ts` — NL description → LLM binary classifier via `LLMClient.complete()`. ~800ms.
   - `semantic-detector.ts` — prompt-based LLM binary classifier. ~800ms.
   - Common interface: `Detector.detect(text, rule): Promise<{ triggered: boolean; score?: number }>`
5. **Aggregator** — `packages/core/src/services/correction-rules/aggregator.ts` — collect triggered rules, sort by priority (lower = higher), cap rewrite-mode at ≤4 (remaining → `overflow_skipped`). Score-mode rules excluded from rewrite pass.
6. **Rewriter** — `packages/core/src/services/correction-rules/rewriter.ts` — single `LLMClient.complete()` call combining original text + all triggered rewrite instructions + rubric items (appended as constraints). Returns rewritten text.
7. **Re-validator** — `packages/core/src/services/correction-rules/re-validator.ts` — instantiate `FalsePromiseValidator` + `IdentityGuardValidator` directly. Call `validateAndMutate()` on rewritten text. 1 pass. Violation → rollback signal.
8. **DAR orchestrator** — `packages/core/src/services/correction-rules/dar-pipeline.ts` — ties cache → detect → aggregate → rewrite → re-validate → rollback. Entry: `execute(text, context): Promise<DARResult>`. Fail-open wrapper: any error → log + return original text.

### Stream 4: QualityEvent Push
9. **Push client** — `packages/core/src/services/correction-rules/event-push-client.ts` — `POST <PRODUCT_API_URL>/v1/quality-events` with Bearer + `X-Tenant-ID`. Fire-and-forget (errors logged via pino, don't block). Fan-out: aggregated rewrite rollback produces N events (one per triggered rule).

### Stream 5: Internal Webhook Route
10. **Rules-reload route** — `packages/api/src/routes/correction-rules-reload.ts` — `POST /v1/internal/rules-reload`. Auth: dedicated `TWIN_INTERNAL_WEBHOOK_SECRET` (Bearer). Body: `{ assistantId, tenantId }`. Calls `ruleCache.invalidate(assistantId)`.

### Stream 6: Integration
11. **chat-service.ts integration** — at `chat-service.ts:418` (after `validateResponse`, before `persistMessages`):
    ```ts
    const darResult = await darPipeline.execute(finalContent, {
      tenantId: request.tenantId,
      personaId: persona.id,
      conversationId,
      rawUserMessage: lastUserMessage,
    });
    const deliveredText = darResult.text;
    ```
    Replace `finalContent` usage downstream (persist, deliver, emit usage) with `deliveredText`. Score-mode async via `setImmediate`.

### Stream 7: Config & Tests
12. **Env config** — Document new env vars in `plan.md` + add inline reads (matching repo's existing `process.env` pattern):
    - `TWIN_PRODUCT_API_URL` — Product base URL (e.g., `http://localhost:3000`)
    - `TWIN_PRODUCT_API_KEY` — Bearer token for outbound Product API calls
    - `TWIN_INTERNAL_WEBHOOK_SECRET` — Shared secret for rules-reload route auth
    - `CORRECTION_RULE_CACHE_TTL_MS` — Cache TTL (default 60000)
13. **Unit tests** — `packages/core/src/services/correction-rules/__tests__/` — detector unit tests (mock LLM), aggregator cap test, re-validation rollback test, cache TTL + invalidation test, pipeline fail-open test.

## Cross-Repo Product Contract

**⚠️ Product side (ai-twins 019) must expose two HTTP endpoints:**

| Endpoint | Direction | Purpose |
|----------|-----------|---------|
| `GET /v1/correction-rules?assistantId=<id>` | Product → Engine (pull) | Full per-assistant rule snapshot. Conditional GET via `If-None-Match`. Returns `{ rules: CorrectionRule[], snapshotVersion: string }` or `304 Not Modified`. |
| `POST /v1/quality-events` | Engine → Product (push) | Batch quality event push. Body: `{ events: QualityEventPush[] }`. Fire-and-forget. |

**Auth pattern** (both directions):
- **Engine → Product** (outbound): `Authorization: Bearer <TWIN_PRODUCT_API_KEY>` + `X-Tenant-ID: <tenantId>`
- **Product → Engine** (inbound webhook): `Authorization: Bearer <TWIN_INTERNAL_WEBHOOK_SECRET>` — dedicated secret, separate from outbound key

**⚠️ Product must also call the Engine webhook on rule CRUD:**
- `POST <ENGINE_API_URL>/v1/internal/rules-reload` with `{ assistantId, tenantId }` + Bearer `TWIN_INTERNAL_WEBHOOK_SECRET`

## Project Structure

```text
packages/core/src/services/correction-rules/
├── types.ts                        # NEW: CorrectionRule, DetectorConfig, QualityEventPush, DARResult, verdict enum
├── product-client.ts               # NEW: HTTP pull from Product API (ssrfSafeFetch)
├── rule-cache.ts                   # NEW: in-memory TTL cache + webhook invalidation
├── dar-pipeline.ts                 # NEW: orchestrator (detect → aggregate → rewrite → re-validate → rollback)
├── event-push-client.ts            # NEW: HTTP push quality events to Product (fire-and-forget)
├── aggregator.ts                   # NEW: collect triggered rules, sort by priority, cap ≤4
├── rewriter.ts                     # NEW: single LLM rewrite pass (aggregated instructions)
├── re-validator.ts                 # NEW: reuse 004 false-promise + identity-guard validators
├── detectors/
│   ├── detector.ts                 # NEW: Detector interface
│   ├── regex-detector.ts           # NEW: RegExp test
│   ├── keyword-detector.ts         # NEW: word list check
│   ├── pattern-detector.ts         # NEW: NL description → LLM binary classifier
│   └── semantic-detector.ts        # NEW: prompt → LLM binary classifier
└── __tests__/
    ├── dar-pipeline.test.ts        # NEW: integration (mock LLM + mock cache)
    ├── detectors.test.ts           # NEW: unit tests per detector type
    ├── aggregator.test.ts          # NEW: cap + sort + overflow
    ├── re-validator.test.ts        # NEW: rollback on false-promise
    ├── rule-cache.test.ts          # NEW: TTL + invalidation
    └── event-push-client.test.ts   # NEW: fire-and-forget, no-throw on error

packages/api/src/routes/
└── correction-rules-reload.ts      # NEW: POST /v1/internal/rules-reload (shared-secret auth)

packages/api/src/server.ts          # MODIFY: register correction-rules-reload route
packages/core/src/services/chat-service.ts  # MODIFY: integrate DAR at line ~418
```

**Structure Decision**: New `correction-rules/` service directory under `packages/core/src/services/` (same level as `grounding/`, `validators/`). Fastify route in `packages/api/src/routes/` following existing plugin pattern. Integration point in `chat-service.ts` at the existing post-validation slot.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Product API endpoints not implemented yet | High | Critical | Build against contract; mock Product API in tests/dev. Cache works without Product — just returns empty rules → DAR no-op. |
| Semantic detector latency exceeds budget | Medium | High | Parallelize ≤3 concurrent LLM calls; structural detectors (regex/keyword) always run first (0 LLM). FR-013: overflow → skip lowest-priority score-mode semantic. |
| Re-validation via direct validator instantiation breaks if 004 internals change | Low | Medium | Re-validator wraps 004 validators behind a stable internal interface; unit test catches regressions. |
| Cache invalidation webhook DoS | Low | High | `TWIN_INTERNAL_WEBHOOK_SECRET` auth on route; unauthenticated → 401, cache untouched. |
| Product push failures silently drop events | Medium | Low | Fire-and-forget is intentional (Phase 1). Events logged via pino. Dashboard has gaps, acceptable. No retry queue. |
| Score-mode async events lost on crash | Medium | Low | `setImmediate` fire-and-forget is accepted for advisory mode (spec clarification). No BullMQ queue in Phase 1. |
| 015 CL-A6 gate bypass (reengagement skips validateResponse) | Medium | High | Precondition: fix CL-A6 before shipping 018. DAR inherits the gate; a bypass means DAR can be skipped on reengagement path. |

## Phase 0: Research (Pre-Implementation)

No research required. The spec is fully clarified (3 clarify rounds). The detector taxonomy, DAR flow, and Engine contract are defined. No NEEDS CLARIFICATION items remain.

## Env Var Requirements

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `TWIN_PRODUCT_API_URL` | YES | — | Product base URL (e.g., `http://localhost:3000`). If unset → DAR skipped (fail-open). |
| `TWIN_PRODUCT_API_KEY` | YES | — | Bearer token for outbound Product API calls. |
| `TWIN_INTERNAL_WEBHOOK_SECRET` | YES | — | Shared secret for `POST /v1/internal/rules-reload` route auth. |
| `CORRECTION_RULE_CACHE_TTL_MS` | NO | `60000` | Rule cache TTL in milliseconds. |
| `TWIN_DAR_SEMANTIC_CONCURRENCY` | NO | `3` | Max concurrent semantic/pattern LLM detector calls per turn. |
| `TWIN_DAR_SEMANTIC_TIMEOUT_MS` | NO | `5000` | Per-detector LLM call timeout. Exceeded → fail-open (score) / fail-closed (rewrite). |

**⚠️ Bootstrap behavior**: If `TWIN_PRODUCT_API_URL` or `TWIN_PRODUCT_API_KEY` is unset → DAR is disabled (skipped entirely, zero overhead). Logged once at startup as warning.
