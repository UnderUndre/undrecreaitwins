# Feature Specification: Response Quality Rules Runtime (DAR Pipeline)

**Feature Branch**: `018-response-quality-rules`
**Created**: 2026-06-14
**Status**: CLARIFIED (session 2026-06-14)
**Input**: Engine-side runtime for custom correction rules. Paired with ai-twins Product spec `019-response-quality-rules` (editor + dashboard). Product stores rules in Prisma; Engine pulls via HTTP, executes DAR pipeline, pushes quality events back.
**Cross-repo pair**: ai-twins `specs/019-response-quality-rules/` (Product layer — rule editor + calibration dashboard)

## Overview

The engine already has a fixed `ValidatorPipeline` (spec 004) with 3 hardcoded validators (false-promise, identity-guard, format-injection). That pipeline catches **structural** safety violations — it's the mandatory baseline.

This spec adds a **dynamic rule execution layer** on top: operators create custom correction rules via the Product admin UI (ai-twins 019). Each rule specifies *what to detect* (detector type + config) and *what to do* (rewrite instruction for the LLM, or score-only logging). The engine pulls these rules per-assistant, executes them in a **DAR pipeline** (Detect → Aggregate → Rewrite), and pushes quality events back to Product for the calibration dashboard.

**Scope**:
- Rule pull client (HTTP from Product)
- Per-assistant rule cache (TTL + webhook invalidation)
- DAR pipeline executor: detect (regex/keyword/pattern/semantic) → aggregate (priority + cap ≤4) → rewrite (single LLM pass)
- Re-validation of rewrite output (1 pass through false-promise + identity-guard)
- Rollback on re-validation failure
- QualityEvent push client (HTTP to Product)
- Integration into `chat-service.ts` (after 004 validators, before message persistence)

**Out of scope**:
- Rule editor UI (Product layer — ai-twins 019)
- QualityEvent dashboard (Product layer)
- Rule storage (Product Prisma)
- Sandbox preview (Phase 3)

## Clarifications

### Session 2026-06-14

- **Q: DAR vs 004 — replacement or extension?** → A: **Extension**. 004 ValidatorPipeline runs FIRST (structural safety baseline). DAR runs AFTER, on the already-validated text. DAR operates on custom operator rules (tone/scope/style), not the safety-critical structural guards. Both can mutate the response — 004 for safety, DAR for quality.
- **Q: How does Engine authenticate to ai-twins HTTP API?** → A: **Bearer token** via `TWIN_PRODUCT_API_KEY` env var. URL via `TWIN_PRODUCT_API_URL` (e.g., `http://localhost:3000`). Headers: `Authorization: Bearer <key>` + `X-Tenant-ID: <tenantId>`.
- **Q: Semantic detector — same LLMClient or separate model?** → A: **Same LLMClient** (BYOK resolved per-assistant via `resolveEffectiveConfig`). Semantic detectors use `LLMClient.complete()` with a binary classification prompt. No separate model deployment. Score-mode semantic detectors run async (do not block reply path).
- **Q: Streaming path?** → A: **Non-streaming only** in Phase 1 (same limitation as 004). DAR applies to the non-streaming reply path. Streaming + DAR deferred.
- **Q: Re-validation — same 004 pipeline or new?** → A: **Reuse 004 pipeline's `validateResponse`** (false-promise + identity-guard only). After DAR rewrite, call `validatorPipeline.validateResponse(rewrittenText, context)` with a special flag to skip non-critical validators. 1 pass. If violation → rollback to pre-DAR text.
- **Q: Cache invalidation webhook — where does Engine receive it?** → A: New Fastify route `POST /v1/internal/rules-reload` in `packages/api/src/routes/`. Body: `{ assistantId, tenantId }`. Invalidates the in-memory cache entry for that assistant.

### Session 2026-06-14 (Clarify Round 1)

- **Q: Score-mode async — how?** → A: **`setImmediate` fire-and-forget** in Phase 1. After the reply is delivered to the customer, the score-mode semantic detector runs in the same Node process via `setImmediate(() => runScoreDetector(...))`. Events may be lost on crash — acceptable for advisory mode. No BullMQ queue for this in Phase 1.
- **Q: RubricItems in Phase 1?** → A: **Ignored for evaluation, included in rewrite prompt as constraints**. If a rule has `rubricItems` and `mode=rewrite`, the items are appended to the rewrite LLM prompt as additional constraints ("Also ensure: ☑ acknowledged the objection, ☑ offered an alternative"). No conversation-level evaluation — items are treated as rewrite guidance only.
- **Q: Empty rule set?** → A: **No-op**. If an assistant has 0 correction rules (or all disabled), DAR is skipped entirely (zero LLM calls, zero latency). Check happens after cache pull.
- **Q: Detector timeout?** → A: **5s per semantic detector LLM call** (separate from `TWIN_STREAM_TIMEOUT_MS`). If exceeded: fail open for score-mode (skip event), fail closed for rewrite-mode (skip that rule's rewrite).
- **Q: DAR runs on 004 fallback text (identity-guard total rewrite)?** → A: **Yes, but DAR rules should not trigger on canned fallback messages**. The rewrite instruction for identity-guard fallback is pre-written safe text. If DAR rules match it (unlikely), they'd rewrite the fallback — acceptable (operator's rules are their choice), but log a warning if DAR fires on a 004-rewritten text.
- **Q: Env var naming?** → A: `TWIN_PRODUCT_API_URL` + `TWIN_PRODUCT_API_KEY` (mirrors Product-side `TWIN_ENGINE_URL` pattern).

### Session 2026-06-14 (Clarify Round 2)

- **Q: reload-вебхук `POST /v1/internal/rules-reload` — чем аутентифицируется?** → A: **Выделенный shared-secret** `TWIN_INTERNAL_WEBHOOK_SECRET` (Bearer/HMAC-проверка на маршруте). Отдельный от исходящего `TWIN_PRODUCT_API_KEY` (разделение секретов). Неаутентифицированный запрос → `401`, кэш не трогается (закрывает DoS/cache-poison).
- **Q: pull правил — инкремент (`since`) или полный snapshot?** → A: **Полный snapshot** per-assistant. `since` убирается из FR-001; `snapshotVersion` используется для детекции изменений (условный GET → `304`). Наборы малы, полная замена проще, нет багов трекинга удалений/мерджа.
- **Q: канонический `verdict` enum?** → A: **`pass | fail | rewritten | rolled_back | overflow_skipped`** (5 значений). `overflow_skipped` трекает >4-cap кейс (edge case). Канон для acceptance-тестов + контракта с Product.
- **Q: чем ограничен LLM-расход на DAR-ход (NFR-4 «capped»)?** → A: **Конфигурируемый soft-default call-cap + per-tenant бюджет (010 OpenMeter) как реальный потолок.** Жёсткого фикс-ceiling НЕТ: число LLM-вызовов легитимно растёт с числом кастомных правил/гардов, которое задаёт бизнес. Regex/keyword — без лимита (0 LLM). Semantic/pattern (LLM) — конфигурируемый дефолт concurrency (≤3) + общее число растёт с правилами; расход бьётся per-tenant бюджетом 010, не отказом от правил. Превышение бюджета → деградация (FR-013: скип lowest-priority score-mode semantic), не хард-кат.

### User Story 1 — Custom rule detection (Priority: P1)

A sales twin has a rule: "Remove meta-preambles like 'Вот ваш ответ:'". The twin generates a reply starting with "Вот ваш ответ: Да, этот диван доступен...". The DAR pipeline detects the preamble (regex match), rewrites the reply to remove it, and delivers "Да, этот диван доступен..." to the customer.

**Independent Test**: Configure a regex rule matching "Вот ваш ответ:" in score mode. Send a reply containing the preamble through chat-service. Confirm: (a) the event is recorded in Product, (b) the reply text is NOT mutated (score mode = advisory), (c) the event has verdict=fail and the original text. Switch to rewrite mode, resend → confirm reply text is cleaned, verdict=rewritten.

**Acceptance Scenarios**:
1. **Given** an active rewrite-mode regex rule, **When** a reply matches the pattern, **Then** the DAR pipeline rewrites it and the delivered text is clean.
2. **Given** a score-mode rule, **When** a reply matches, **Then** the reply is NOT mutated but a QualityEvent with verdict=fail is pushed to Product.
3. **Given** multiple rewrite rules match (≤4), **When** DAR runs, **Then** they are aggregated into a single rewrite LLM pass (not N separate calls).

### User Story 2 — Semantic detection (Priority: P1)

A rule with detector type=semantic has prompt "Is this response off-topic for a furniture store?" and rewrite instruction "Politely redirect to furniture topics." The twin generates a reply that starts answering a recipe question (prompt injection succeeded). The semantic detector (LLM binary classifier) flags it, the rewriter fixes it.

**Independent Test**: Configure a semantic rule. Send an off-topic reply through the pipeline. Confirm the semantic detector fires (LLM call), event is pushed, and in rewrite mode the text is corrected.

**Acceptance Scenarios**:
1. **Given** an active semantic rule, **When** the LLM classifier returns positive (violation detected), **Then** the rule triggers (rewrite or score per mode).
2. **Given** a semantic rule in score mode, **When** the detector fires, **Then** the reply is NOT blocked (async advisory), but the event is recorded.

### User Story 3 — Re-validation + rollback (Priority: P1)

The DAR rewrite fixes an em-dash issue but accidentally introduces a false promise ("конечно, доставим бесплатно"). The re-validation pass (false-promise + identity-guard) catches the new violation. The pipeline rolls back to the pre-DAR text. A QualityEvent with verdict=rolled_back is pushed.

**Independent Test**: Craft a scenario where a rewrite introduces a false promise. Confirm rollback fires, original text is delivered, and the event shows verdict=rolled_back with fan-out (one event per triggered rule).

**Acceptance Scenarios**:
1. **Given** a rewrite that introduces a false promise, **When** re-validation runs, **Then** the rewrite is discarded and the pre-DAR text is delivered.
2. **Given** a rollback from an aggregated rewrite (3 rules), **When** events are pushed, **Then** 3 QualityEvent rows are written (one per rule) with verdict=rolled_back.

### User Story 4 — Rule cache invalidation (Priority: P2)

An operator updates a rule in the Product UI. The webhook `POST /v1/internal/rules-reload` fires. Engine invalidates the cache for that assistant. The next reply uses the updated rule.

**Independent Test**: Create a rule, send a message (rule fires). Update the rule via Product API. Wait for webhook (or TTL). Send another message. Confirm the updated rule is in effect.

**Acceptance Scenarios**:
1. **Given** a cached rule set for assistant A, **When** a webhook `{ assistantId: A }` arrives, **Then** the cache entry is purged and the next pull fetches fresh rules.
2. **Given** no webhook (Engine was down), **When** 60s TTL expires, **Then** the next reply triggers a fresh pull.

## Functional Requirements

- **FR-001**: Rule pull client — `GET <PRODUCT_API_URL>/v1/correction-rules?assistantId=<id>` with Bearer auth + X-Tenant-ID. Returns the **full per-assistant rule set**: `{ rules: CorrectionRule[], snapshotVersion: string }` (CL Round 2 — no incremental `since`). **Conditional GET**: client sends `If-None-Match: <snapshotVersion>` (or `?knownVersion=`); unchanged → `304 Not Modified`, cache kept. Changed → full set replaces the cache entry. Implemented as a new service `CorrectionRuleCache` in `packages/core/src/services/correction-rules/`.
- **FR-002**: Per-assistant rule cache with TTL (default 60s, configurable via `CORRECTION_RULE_CACHE_TTL_MS`) + webhook invalidation (`POST /v1/internal/rules-reload`). **Webhook auth (CL Round 2)**: route MUST verify a dedicated shared secret `TWIN_INTERNAL_WEBHOOK_SECRET` (Bearer or HMAC over body), separate from `TWIN_PRODUCT_API_KEY`. Unauthenticated/invalid → `401`, cache untouched (closes DoS/cache-poison vector). Full snapshot re-pulled on next reply after invalidation.
- **FR-003**: DAR pipeline executor — new service `DARPipeline` in `packages/core/src/services/correction-rules/dar-pipeline.ts`. Orchestrates: detect → aggregate → rewrite → re-validate.
- **FR-004**: Detector implementations (4 types):
  - `RegexDetector`: compile `new RegExp(pattern, flags)`, test against text. <1ms.
  - `KeywordDetector`: check if any/all words from list appear in text. <1ms.
  - `PatternDetector`: natural language description → LLM binary classifier via `LLMClient.complete()`. ~800ms.
  - `SemanticDetector`: prompt-based LLM binary classifier. ~800ms.
- **FR-005**: Detector aggregation — collect all triggered rules. Sort by priority (lower = higher). Cap rewrite-mode rules at ≤4 per pass (Curse of Instructions). Score-mode rules do not enter the rewrite pass.
- **FR-006**: Rewrite execution — single `LLMClient.complete()` call combining: original text + all triggered rewrite instructions (aggregated into one prompt) + rubric items (if any). Returns rewritten text.
- **FR-007**: Re-validation — after rewrite, run `validatorPipeline.validateResponse(rewrittenText, { ...context, darRevalidation: true })`. This calls false-promise + identity-guard validators only (skip others via a flag). 1 pass. No infinite loop.
- **FR-008**: Rollback — if re-validation detects a violation (verdict != pass), discard the rewrite. Deliver the pre-DAR text. Push QualityEvents with verdict=rolled_back (one per triggered rule — fan-out).
- **FR-009**: QualityEvent push client — `POST <PRODUCT_API_URL>/v1/quality-events` with Bearer auth + X-Tenant-ID. Body: `{ events: QualityEventPush[] }`. Fire-and-forget (errors logged, don't block reply delivery).
- **FR-010**: Integration into `chat-service.ts` — after existing `validateResponse` call (line ~418), call `darPipeline.execute(currentText, context)`. Use the returned text for persistence + delivery.
- **FR-011**: Scope support — `sentence` / `paragraph` / `full`. Phase 1: `full` only (entire reply text). `sentence`/`paragraph` splitting deferred (requires sentence boundary detection).
- **FR-012**: TurnScope support — `single` (per-message) / `conversation` (multi-turn rubric). Phase 1: `single` only. Conversation-level rubric evaluation deferred (requires conversation context accumulation).
- **FR-013**: Latency budget — total DAR latency (detect + aggregate + rewrite + re-validate) p95 < 2s. Budget overflow → skip lowest-priority score-mode semantic detectors. Structural detectors (regex/keyword) always run (0 LLM cost).
- **FR-014**: Error handling — if Product API is unavailable (pull fails), DAR is skipped (reply delivered without custom rules). If push fails, events are logged locally (pino) and dropped (no retry queue in Phase 1). Reply delivery never blocked by DAR failure.
- **FR-015**: Score-mode semantic detectors do NOT block the reply path. They run asynchronously after the reply is delivered — the event is pushed when the classifier completes.

## Non-Functional Requirements

- **NFR-1 (isolation)**: all rule pulls and event pushes scoped by `tenantId` from the request context. No cross-tenant data access. RLS via `withTenantContext` for any Engine-side DB access. **Internal route auth (CL Round 2)**: `POST /v1/internal/rules-reload` verifies `TWIN_INTERNAL_WEBHOOK_SECRET` before touching cache; the route is the only inbound Product→Engine surface for this feature and must not be exposed unauthenticated.
- **NFR-2 (perf)**: DAR total latency p95 < 2s (NFR-6 from Product spec). Regex/keyword detection <1ms each. Semantic detection parallelized (cap ≤3 concurrent LLM calls). Rewrite = 1 LLM call. Re-validation = 1 LLM call (false-promise) — identity-guard is regex-only (0 LLM).
- **NFR-3 (reliability)**: DAR failure (any stage) → log + skip → reply delivered unmodified. Never block customer-facing reply on DAR. Product API unavailable → cached rules used until TTL expiry; if cache empty, DAR skipped.
- **NFR-4 (cost)**: per-turn LLM расход НЕ имеет жёсткого фикс-ceiling (CL Round 2). Число LLM-вызовов **легитимно растёт с числом кастомных правил/гардов**, которое задаёт бизнес — отказывать в правилах ради лимита неверно. Вместо этого:
  - **Конфигурируемые soft-defaults** (env): semantic-детектор concurrency (дефолт ≤3), per-turn detector budget — поднимаются операционно, когда бизнес добавляет гарды.
  - **Реальный потолок = per-tenant бюджет (010 OpenMeter)**, не per-turn call-cap. Расход метрируется (010); превышение бюджета → **деградация** (FR-013: скип lowest-priority score-mode semantic, structural regex/keyword всегда), не отказ от фичи.
  - Regex/keyword детекторы — без лимита (0 LLM cost). Rewrite остаётся **1 LLM-вызов**; quality-cap ≤4 rewrite-правил на pass (FR-005) — отдельное ограничение качества (Curse of Instructions), НЕ стоимости. Score-mode semantic — async, вне reply latency-бюджета.
- **NFR-5 (testability)**: each detector type unit-testable with mock LLMClient. DAR pipeline integration test with mock Product API. Re-validation rollback test with crafted false-promise-in-rewrite scenario.
- **NFR-6 (observability)**: pino logging at each DAR stage (detect count, aggregate count, rewrite latency, re-validation verdict, rollback). Langfuse trace includes DAR span (if available).

## Edge Cases

- **Product API down at pull time** → use cached rules. If cache empty → skip DAR (reply delivered without custom rules). Log warning.
- **Product API down at push time** → events logged locally (pino), dropped. No retry queue in Phase 1. Dashboard will have a gap.
- **Rule references deleted assistant** → pull returns empty list for that assistant. DAR skipped.
- **Regex pattern invalid (compiled at pull time? or rule creation?)** → Product validates at creation (400 BAD_REQUEST). Engine should still wrap `new RegExp()` in try/catch — if invalid pattern slips through, skip that rule, log error.
- **>4 rewrite rules trigger simultaneously** → Engine caps at top-4 by priority. Remaining rules are logged as "overflow-skipped" in the QualityEvent push.
- **Rewrite returns empty string** → rollback to original text (same as 004 FR-019 empty-output guard).
- **Re-validation also fails on the ORIGINAL text** (pre-DAR) → deliver original anyway (004 already validated it). DAR re-validation is a bonus check, not a gate on the original.
- **Semantic detector LLM call times out** → fail open for score-mode (no event pushed, log timeout). Fail closed for rewrite-mode (skip that rule, deliver text without its rewrite).
- **Conversation-level rubric rule (turnScope=conversation) in Phase 1** → engine ignores the turnScope field, treats as single-message. Log a warning that conversation-level evaluation is not yet supported.

## Key Entities

- **CorrectionRule** (read from Product via HTTP, NOT stored in Engine DB): `{ id, tenantId, assistantId, name, detector: { type, config }, rewriteInstruction, mode, priority, scope, turnScope, isEnabled, rubricItems }`.
- **QualityEventPush** (written to Product via HTTP): `{ assistantId, ruleId, ruleName, conversationId, messageId, mode, verdict, originalText?, rewrittenText?, score?, latencyMs, rolledBack }`. **`verdict` enum (CL Round 2)**: `'pass' | 'fail' | 'rewritten' | 'rolled_back' | 'overflow_skipped'` — canonical set (`overflow_skipped` = rule triggered but dropped by the ≤4 rewrite cap, FR-005).
- **RuleCacheEntry**: `{ rules: CorrectionRule[], snapshotVersion: string, fetchedAt: number }`.

## Dependencies

- **004-validators** (prerequisite): ValidatorPipeline must run BEFORE DAR. DAR re-validation reuses 004's `validateResponse` for false-promise + identity-guard.
- **LLMClient** (existing): `complete()` for semantic detection + rewrite. BYOK resolved per-assistant.
- **ai-twins Product API** (external): `GET /v1/correction-rules` + `POST /v1/quality-events`. Requires `TWIN_PRODUCT_API_URL` + `TWIN_PRODUCT_API_KEY` env vars.
- **015 CL-A6 gate bypass** (precondition): if the outbound validator gate has a bypass (reengagement path skips validateResponse), DAR re-validation inherits that hole. Must be fixed first.

## Success Criteria

- **SC-001**: DAR pipeline integrated into chat-service — custom rules fire on non-streaming replies.
- **SC-002**: Regex/keyword detectors fire in <1ms with 0 LLM calls.
- **SC-003**: Semantic detector fires via LLMClient with binary classification.
- **SC-004**: Rewrite aggregates ≤4 rules into a single LLM pass.
- **SC-005**: Re-validation catches false-promise introduced by rewrite → rollback fires.
- **SC-006**: QualityEvents pushed to Product → visible in calibration dashboard.
- **SC-007**: DAR total latency p95 < 2s on non-streaming path.
- **SC-008**: DAR failure (any stage) does NOT block reply delivery.

## Glossary

- **DAR** — Detect → Aggregate → Rewrite: the correction rule execution pipeline.
- **CorrectionRule** — operator-created custom rule (from Product UI). NOT a 004 catalog validator.
- **rewrite mode** — gate: rule fixes the response. **score mode** — advisory: rule logs only.
- **Re-validation** — post-rewrite safety check through 004 false-promise + identity-guard.
- **Rollback** — discard rewrite, deliver pre-DAR text, when re-validation fails.
- **Fan-out** — aggregated rewrite rollback produces N QualityEvents (one per rule).
