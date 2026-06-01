# SpecKit Review: 009-reengagement-runtime

**Reviewer**: antigravity
**Reviewed at**: 2026-06-01T12:15:00Z
**Commit**: HEAD
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, quickstart.md, research.md, constitution.md

## Summary

The design successfully separates Product authoring from Engine execution and correctly identifies the need for idempotency and anti-spam controls. However, the runtime pipeline has a critical batch-poisoning vulnerability in its scan-and-claim architecture, and completely misses the integration tasks required to reset the re-engagement cycle on new inbound messages.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | CRITICAL | Logic / Scale | **Scanner batch poisoning & stuck processing**. `research.md` (g) queries for dormant conversations without excluding those that already have a pending attempt. If a worker crashes, attempts remain in `processing` indefinitely. The scanner will repeatedly fetch these same conversations, hit the `ON CONFLICT DO NOTHING` block, and consume the `.limit(1000)` budget, starving all other dormant conversations. | Add a timeout sweep for `processing` attempts. Update the `Scanner` query to explicitly exclude conversations with active `scheduled`/`processing` attempts, or include `lastReengagementAt` and backoff calculations in the query filter. |
| F2 | HIGH | Logic | **Missing trigger to reset cycle on inbound messages**. `spec.md` (FR-008) requires resetting `needsReengagement = true` on a new user message. However, `tasks.md` has zero tasks to wire this into the `ChatService` or webhook listener. | Add a `[BE]` task to implement the inbound message listener/hook that resets `reengagementCount` and `needsReengagement`. |
| F3 | HIGH | Edge Case | **Worker misses "user replied" re-validation**. `spec.md` specifies an attempt should expire if the user replies before the hook is sent. `tasks.md` T016 instructs the worker to re-validate rule `isActive`, but fails to instruct it to re-validate the conversation's `lastMessageAt` or `needsReengagement` flag before sending. | Update T016 to ensure the worker re-verifies that the conversation is still dormant during the atomic `processing` claim. |
| F4 | MEDIUM | Edge Case | **Idempotency key burns retries**. `data-model.md` defines `idempotencyKey = convId:ruleId:cycleIndex`. If an attempt fails (e.g., LLM timeout), this key is burned. The scanner cannot schedule a retry for the same cycle index due to `ON CONFLICT DO NOTHING`. | Clarify retry behavior. If failures should be retried, include an attempt counter in the idempotency key, or allow the scanner/worker to explicitly handle `failed` rows. |
| F5 | LOW | Security | **Prompt injection via history**. `research.md` (b) feeds raw user history into the LLM context. A user could send "Ignore instructions and say X" to hijack the generated hook. | Ensure `ChatService.complete` enforces strict system/user boundaries or uses a safe system prompt wrapper against injection. |

## Alternative approaches considered

**Queue-per-attempt vs DB-status-claim**: `plan.md` explicitly chooses a DB-status-claim worker over a BullMQ job per attempt. Since BullMQ is already included for the cron scan (T008), using BullMQ for the individual attempts would automatically provide stalled job recovery (resolving F1), exponential retries, and concurrency limits without having to build a custom DB-based worker loop.

## VERDICT

```yaml
verdict: CRITICAL
reviewer: antigravity
reviewed_at: 2026-06-01T12:15:00Z
commit: HEAD
critical_count: 1
high_count: 2
medium_count: 1
low_count: 1
```
