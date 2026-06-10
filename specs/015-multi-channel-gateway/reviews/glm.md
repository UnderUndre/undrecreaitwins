# SpecKit Review: 015-multi-channel-gateway

**Reviewer**: glm
**Reviewed at**: 2026-06-09T18:30:00+03:00
**Commit**: 9e30d79147fca33e4a843e450f2f0d322244c1df
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/channel-adapter.contract.md, research.md, quickstart.md, .specify/memory/constitution.md, reviews/gemini.md
**Review type**: re-review (original 2026-06-09T03:15:00+03:00, updated after implementation progress)

## Summary

Implementation is substantially further than the original review assessed. All 11 channel packages now have **real adapter implementations** (not stubs), shared modules (`webhook-signature.ts`, `channel-rate-limiter.ts`, `channel-provisioning.ts`) are shipped, and the reengagement validator bypass (CL-A6) is **fixed in code** — `delivery.ts` now routes through `ValidatorPipeline.validateResponse()` before OUTBOUND. The two original CRITICAL findings are both resolved. Remaining weaknesses: (1) 4 of 11 channel adapters have zero tests (matrix, sms, webhooks, homeassistant) — a quality gap that violates the "verify before done" workflow; (2) `attachments[]` wiring through INBOUND/OUTBOUND payload (T009) is still open, which means media is extracted inbound but not yet propagated through the full pipeline; (3) Honcho DB isolation was fixed infra-side but spec/plan still describe the old shared-DB topology.

## Original Findings — Status Update

| ID | Original Severity | Original Finding | Current Status |
|---|---|---|---|
| F1 | **CRITICAL** | Principle IX — cross-repo spec/impl split | **RESOLVED**: spec tree re-homed to `undrecreaitwins/specs/015-*/`. Implementation runs in same repo. |
| F2 | **CRITICAL** | Gate-0 CL-A6 — reengagement bypass, no fallback | **RESOLVED**: `delivery.ts` now calls `validatorPipeline.validateResponse()` (line 43) before OUTBOUND publish. Clean implementation, not a stopgap. External chip no longer blocks 015. |
| F3 | **HIGH** | Webhook signature — no shared module | **RESOLVED**: `webhook-signature.ts` shipped with 4 verifiers (generic HMAC-SHA256, Feishu timestamp+nonce, WeCom SHA1 sorted-array, generic webhook with `sha256=` prefix). Uses `timingSafeEqual` throughout. Feishu, WeCom, and generic webhook adapters all delegate to shared module. |
| F4 | **HIGH** | Channel provisioning API missing | **RESOLVED**: `channel-provisioning.ts` shipped. Accepts `{ tenantId, personaSlug, channelType, credentials, config }`, encrypts via `KmsProvider`, generates channelId, returns `{ channelId, ciphertext, kmsKeyRef, committed }`. Engine-side contract exists. API route integration pending (016 T013 per plan). |
| F5 | **HIGH** | Adapter crash + Redis Streams XPENDING | **PARTIALLY RESOLVED**: data-model.md now documents `XPENDING_IDLE_MS` (default 5 min) and crash-window semantics (delayed, not lost). Contract updated. But no task actually **tests** this (T023 still open). Monitoring for pending > threshold — not implemented. |
| F6 | **MEDIUM** | 15+ consumer processes — resource overhead | **OPEN**: no coalescing or multiplexer. Each adapter = separate process. Acceptable for Phase 1 volumes. Revisit if resource pressure surfaces. |
| F7 | **MEDIUM** | Health aggregation missing | **RESOLVED in spec/contract**: data-model.md specifies `GET /api/channels/health` → `{ channels, overall }`, tenant-scoped, ~30s poll cached in Redis. T021 still open (implementation). |
| F8 | **MEDIUM** | Rate-limit enforcement layer | **RESOLVED**: `channel-rate-limiter.ts` shipped. 12 platforms configured. Sliding 1-second window. All adapters call `rateLimiter.check()` before send. |
| F9 | **MEDIUM** | Streaming guard non-normative | **RESOLVED in contract/plan**: plan.md specifies runtime assertion in orchestrator OUTBOUND consumer. data-model.md documents it. Implementation in orchestrator — needs verification (T023). |
| F10 | **MEDIUM** | Credential rotation with zero downtime | **RESOLVED in spec/contract**: `kmsKeyRef` column spec'd, rotation flow described in contract. T030 task exists. Implementation pending. |
| F11 | **LOW** | No snapshot tags visible | **OPEN**: snapshot-stage tags not verified in this re-review. Low priority. |
| F12 | **LOW** | Hermes reference — no version pin | **OPEN**: Hermes commit SHA not pinned in research.md. Low priority. |
| F13 | **LOW** | Phase 1/Phase 2 channel list discrepancy | **RESOLVED**: tasks.md now has explicit spec-phase ↔ task-phase map (glm-F13 section). |

## New Findings (implementation-based)

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F14 | **HIGH** | Testing | **4 channel adapters have zero tests** (matrix, sms, webhooks, homeassistant). Per audit: these are real implementations (188–362 LOC each) with real external deps (`matrix-bot-sdk`, `twilio`, raw HTTP, `ws`), but no integration or unit tests. This is a quality gap — adapter logic (signature verification, token caching, WS auth flow, event parsing) is untested. Per quickstart §Quality gates: "Per-package `vitest` integration tests green." | Add integration tests for all 4 packages. Minimum coverage: connect/disconnect lifecycle, credential validation, inbound publish with tenant stamping, outbound send, channel_id filtering, rate limiter, tenant isolation. Follow the pattern from `channel-discord` (20 tests) or `channel-dingtalk` (13 tests). |
| F15 | **HIGH** | Completeness | **T009 (attachments wiring) not implemented** — spec FR-001 adds `attachments[]` to `ChannelMessage`, and adapters (Discord, Slack, Email) already extract attachments inbound. But `channel-orchestrator.ts` and the INBOUND/OUTBOUND payload schema in data-model.md don't wire `attachments?` through the stream payload. The orchestrator passes `content` only — attachment metadata is lost between inbound adapter and outbound adapter. Media in/out (US2) is blocked. | Implement T009: extend INBOUND payload to include `attachments?`, wire through orchestrator, extend OUTBOUND payload similarly. Verify end-to-end: image → Discord inbound → orchestrator → outbound → Discord send with attachment. |
| F16 | **MEDIUM** | Spec drift | **Honcho DB topology changed but spec/plan not updated**. Implementation: honcho now runs on its own `HONCHO_DB` database (separate from `twinengine`), created via `init-honcho-db.sh` initdb script. Spec and plan still describe honcho connecting to `POSTGRES_DB` (= `twinengine`). If someone follows the spec to deploy, they'll hit the original `DuplicateTable` conflict. | Update plan.md §Technical Context and data-model.md to note honcho's separate database. Add `HONCHO_DB` to `.env.example` documentation section. Already in infra config, just spec lag. |
| F17 | **MEDIUM** | Completeness | **VK (CL-A8) and Avito (CL-A9) adapters not implemented**. Spec explicitly includes these in Phase 1 (VK) and Phase 2 (Avito) phasing. Tasks.md doesn't have dedicated tasks for either — they were presumably covered by "Phase 7: Phase-2 channels" but VK is Phase 1. No `channel-vk` or `channel-avito` package exists. | Add explicit tasks for VK adapter (Phase 1 per spec) and Avito adapter (Phase 2). VK: Community Bot API, Long Poll, `inboundMode:'bot'`. Avito: Messenger webhook V3, OAuth Bearer. These are user-requested channels (CL-A8/A9) with locked decisions — they shouldn't be implicit. |
| F18 | **MEDIUM** | Security | **Slack adapter uses raw HTTP + manual HMAC, not `@slack/bolt`**. The adapter correctly implements signature verification, but the plan explicitly specifies `@slack/bolt` (Socket Mode) as the dep. Current implementation is an HTTP webhook server — this means Slack requires a **public URL** per-tenant, contradicting DL-5/CL-A3 ("Socket Mode, outbound connection, no public URL"). | Either: (A) implement proper Socket Mode with `@slack/bolt` as spec'd (no public URL), or (B) update spec/plan to acknowledge Slack is webhook-mode with public URL requirement, and ensure tenant-scoped URL provisioning. Current state = spec says socket, code does webhook. |
| F19 | **MEDIUM** | Reliability | **`channel-provisioning.ts` returns `committed: false` always**. The function encrypts creds and generates channelId but never writes to DB — the caller must persist. This is by design (separation of concerns), but there's no documentation or caller-side code that actually persists. If a caller forgets to persist, creds are encrypted in memory and lost. | Either: (A) document the required caller-side persistence pattern (DB write + adapter connect) with a code example, or (B) add an option `commit: true` that writes to `channel_instances` via drizzle. Current half-done state is a footgun. |
| F20 | **LOW** | Ops | **twin-engine healthcheck was using `wget` (unavailable in Node Alpine)**. Fixed in compose to use `node -e fetch(...)`. Not a spec issue, but worth noting: the Docker image healthcheck should be validated in CI, not just locally. | Add a note to T025 (deploy config): validate healthcheck command works in the target image. |

## Alternative approaches considered

1. **Test the untested 4 adapters minimally**: instead of full integration tests, add unit tests for critical paths only (signature verification, auth flow, message parsing). Reduces test count but covers the riskiest code. Trade-off: less confidence vs. faster delivery. Recommended: follow existing pattern (discord: 20 tests) for consistency.

2. **Merge VK/Avito into existing Phase 2 channel task**: instead of separate tasks, add VK to T013-T015 lane and Avito to T016-T020 lane. Less task overhead but loses the explicit user-requested channel visibility.

## VERDICT

```yaml
verdict: MEDIUM
reviewer: glm
reviewed_at: 2026-06-09T18:30:00+03:00
commit: 9e30d79147fca33e4a843e450f2f0d322244c1df
critical_count: 0
high_count: 3
medium_count: 5
low_count: 1
notes: >
  Original CRITICAL findings (F1: cross-repo, F2: reengagement bypass) both resolved.
  Remaining HIGHs are quality/completeness (untested adapters, missing attachments wiring,
  Slack mode mismatch) — addressable without rework of existing code.
  Implementation ahead of spec on infra (Honcho DB split) — spec needs catch-up.
```
