# Feature Specification: Re-engagement Runtime

**Feature Branch**: `009-reengagement-runtime` *(git branch pending)*
**Created**: 2026-05-31
**Status**: Draft (runtime half of the re-engagement split — planned, ready for review)
**Input**: Runtime extracted from the Product spec `ai-twins/specs/006-reengagement-admin`, which is the **admin/config half**. This Engine spec owns the **runtime half**.

## Overview

A **hook** is an AI-generated outbound message sent to re-engage a dormant user (a "win-back" message). The Re-engagement Runtime scans dormant conversations and sends hooks through the channel adapters, governed by the follow-up rules authored in the Product (`FollowupRule`). It runs in the **Engine** (`undrecreaitwins`) because it needs:

- high-frequency scans of the **primary Drizzle `conversations` table** (Product only has a read-only mirror — see `docs/boundary_ownership_audit.md` §D/§F),
- the Engine `ChatService` to generate context-aware hooks,
- the Engine **channel adapters** (`packages/channel-telegram*`, `channel-whatsapp`) to deliver.

> **Split boundary**: Product (`ai-twins`, `006-reengagement-admin`) authors `FollowupRule` and reads `FollowupAttempt` history. This Engine runtime **reads** `FollowupRule` and **writes** `FollowupAttempt`. Same runtime↔admin pattern as `003-script-funnels` (runtime) ↔ `002-funnel-editor` (admin) and `004-validators` ↔ `008-validator-admin`. Source anatomy: `ai-twins/docs/validators_reengagement_anatomy.md` §2 (legacy `server/services/reengagement/`: `scanner.ts`, `generator.ts`, `hookGenerator.ts`, `scheduler.ts`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Scan dormant conversations (Priority: P1) 🎯 MVP
The runtime periodically scans `conversations` for ones idle past a rule's `triggerStaleMinutes` (and matching `conditions`), and schedules a follow-up attempt — without exceeding `maxAttempts`/backoff.

**Acceptance**: Given a conversation idle beyond an active rule's threshold and under its attempt budget, when the scanner runs, then a `FollowupAttempt(status=scheduled)` is created for it; a conversation already at `maxAttempts` or within backoff is skipped.

### User Story 2 - Generate & deliver hook (Priority: P1)
For each scheduled attempt, the runtime asks `ChatService` for a contextual hook and delivers it via the conversation's channel adapter, then records the outcome.

**Acceptance**: Given a scheduled attempt, when processed, then a hook is generated from recent conversation context and sent via the correct channel; the attempt transitions to `sent` (or `failed` with a reason). No duplicate send for the same attempt.

### User Story 3 - Respect opt-out & anti-spam (Priority: P2)
The runtime honors per-conversation opt-out and the rule's frequency caps (backoff schedule, max attempts, ≥ N hours between hooks).

**Acceptance**: Given a conversation that opted out or is within the backoff window, when the scanner runs, then no attempt is sent (status `opted_out`/skipped); frequency caps are never exceeded.

### Edge Cases
- **User replies before the hook is sent** → attempt `scheduled → expired` (no hook sent); `needsReengagement` reset for a fresh cycle.
- **Conversation opts out / is closed / handed to a human mid-cycle** → `scheduled → opted_out` (or skipped); no send.
- **Rule deactivated (`isActive=false`) after scheduling** → the worker re-checks rule validity at claim time and drops the attempt (`expired`) instead of sending against a dead rule.
- **Conversation deleted between scan and send** → worker handles the missing row / FK gracefully (no crash; abort or `failed`).
- **LLM hook generation fails** → attempt → `failed` with `failureReason`; no partial/garbage send.
- **Channel transport (Redis) unavailable at hand-off** → attempt → `failed` with reason; no duplicate publish (atomic status guard).
- **Two scans race the same dormant window** → the `UNIQUE(idempotencyKey)` constraint collapses them to one `scheduled` row (no double send).
- **Worker crashes/hangs after claiming** → the attempt is swept `processing → failed('worker_timeout')` after `TWIN_REENGAGE_CLAIM_TIMEOUT_MS` (FR-011); the cycle budget is freed, no phantom stuck row.
- **Multiple active rules match the same conversation** → at most ONE hook per scan, and never two hooks within `minIntervalMinutes` across rules (FR-006).
- **LLM call hangs** → 30 s timeout (`TWIN_REENGAGE_LLM_TIMEOUT_MS`) → attempt `failed('llm_timeout')`, worker freed.
- **A `failed` attempt** → not retried within the same cycle (idempotencyKey consumed); re-evaluated on the next dormancy cycle.
- **Stuck/pending attempt exists** → scanner excludes that conversation for the rule (FR-012); no batch poisoning.

## Requirements *(mandatory)*

### Functional Requirements
- **FR-001**: Scan the primary Drizzle `conversations` table on a schedule (cron/worker) for staleness per active `FollowupRule`.
- **FR-002**: Read `FollowupRule` (authored in Product) to drive thresholds, conditions, backoff, max-attempts, and message template. `conditions` (JSONB) MUST be evaluated per the **Conditions schema** (data-model §Conditions schema): filterable fields (`source`/channel, conversation `tags`) with operators `eq`/`in`/`contains`, applied as additional scan filters.
- **FR-003**: Generate a contextual hook via `ChatService` using recent conversation messages.
- **FR-004**: Deliver via the conversation's channel adapter (Telegram/MTProto/WhatsApp/Web).
- **FR-005**: Write `FollowupAttempt` rows through the full state set (`scheduled` → `processing` → `sent`/`failed`, plus `expired`/`opted_out`) — the single writer of that table. `processing` is the atomic idempotency-claim state (see `attempt-state-machine.contract.md`).
- **FR-006**: Enforce anti-spam: per-rule backoff schedule, per-rule `maxAttempts`, and a **cross-rule minimum interval** (`FollowupRule.minIntervalMinutes`) between *any* two hooks for the same conversation. The scanner MUST schedule **at most one attempt per conversation per scan** (even if multiple rules match) and skip a conversation whose `now() - lastReengagementAt < minIntervalMinutes`. **Backoff overflow**: when `reengagementCount ≥ len(backoff)`, use the **last** `backoff` element for all subsequent attempts.
- **FR-007**: Honor opt-out and conversation status — the scan query MUST exclude `optedOut`, `closed`, and human-handled (operator-assigned) conversations.
- **FR-008**: Own the runtime conversation fields (`needsReengagement`, `lastReengagementAt`, `reengagementCount`, `optedOut`) in **Drizzle**, not in Product Prisma. `needsReengagement` lifecycle: defaults `true` for active conversations; set `false` on opt-out, close, human-handoff, or when `maxAttempts` is reached for all active rules; reset to `true` on a new inbound user message (new dormancy cycle).
- **FR-009**: Idempotency — enforced by a DB `UNIQUE(idempotencyKey)` constraint on `FollowupAttempt` (insert via `ON CONFLICT DO NOTHING`, **never** check-then-insert) so a given `(conversationId, ruleId, cycle)` is scheduled at most once; plus an atomic `scheduled → processing` status claim so it is sent at most once even under concurrent workers/retries.
- **FR-010**: At claim time the worker MUST **re-validate the conversation is still eligible** — still dormant (`lastMessageAt ≤ attempt.scheduledAt`), not opted-out/closed/human-handled, and the rule still `isActive` — before generating/sending; otherwise transition `expired` (no send). Prevents hooking a user who already replied or a rule that was disabled after scheduling.
- **FR-011**: **Stuck-processing recovery** — a periodic sweep MUST move any `processing` attempt whose `claimedAt + TWIN_REENGAGE_CLAIM_TIMEOUT_MS < now()` to `failed` (`failureReason='worker_timeout'`), so a crashed/hung worker never leaves an attempt — and its cycle budget — permanently stuck. `failed` is terminal for the cycle (no in-cycle retry); a later dormancy cycle re-evaluates.
- **FR-012**: The scanner query MUST **exclude conversations that already have an open (`scheduled`/`processing`) attempt** for the same rule, so a stuck/pending row never starves the batch budget (SC-004 batch poisoning).

### Key Entities
- **FollowupRule** (Product-authored, shared DB): read-only here. Thresholds/backoff/template/conditions.
- **FollowupAttempt** (Engine-written, shared DB): the execution log Product reads.
- **conversations / messages** (Engine Drizzle): the scan source + hook context.

## Success Criteria *(mandatory)*
- **SC-001**: Dormant conversations matching an active rule receive at most one hook per backoff interval; 0 attempts exceed `maxAttempts`.
- **SC-002**: **Per-attempt** processing latency (worker **claim** → Redis `OUTBOUND` publish) p95 < 2 s — measures one claimed attempt (one LLM call + publish), NOT whole-batch drain. Batch throughput (a 10k backlog within the 60 s scan interval) is met by **worker concurrency** (plan §Concurrency & Recovery). Nominal load: 10k dormant conversations/run, ≤ 50 active rules/tenant, 60 s scan interval.
- **SC-003**: 0 cross-tenant scans or sends in security testing.
- **SC-004**: Scanner handles ≥ 10k dormant conversations per run via batched queries without locking the DB.

## DD-RE-001 boundary (companion to Product spec)
- **Config ownership**: Product owns `FollowupRule` DDL (authored there). Engine owns runtime conversation fields (Drizzle).
- **Attempt ownership**: Engine is the sole writer of `FollowupAttempt`; Product reads.
- **Migration ownership** for the shared `followup_*` tables MUST be singular — agree with `ai-twins/006-reengagement-admin` research §DD-RE-001 before either side migrates.

## Out of Scope
- Rule authoring UI/API (Product `006-reengagement-admin`).
- Attempt-history dashboard (Product).

## Notes
- **Porting source**: legacy `server/services/reengagement/{scanner,generator,hookGenerator,scheduler}.ts` (anatomy doc §2C) — port core logic, rebuild plumbing on the Engine's worker architecture (§2F). Plan, tasks, and contracts are fleshed out (this spec is no longer a stub); see `plan.md` + `contracts/`.
