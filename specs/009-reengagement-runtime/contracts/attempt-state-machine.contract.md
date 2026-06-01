# Contract: FollowupAttempt State Machine

## Purpose
Manage the lifecycle of a re-engagement attempt and enforce idempotency.

## States
- `scheduled`: Entry state. Scanner identifies a dormant conversation.
- `processing`: Locked state. Generator is calling LLM.
- `sent`: Success state. Published to outbound stream.
- `failed`: Terminal error state.
- `expired`: User replied before hook was sent.
- `opted_out`: User blocked/opted out.

## Transitions & Invariants

| From | To | Trigger | Condition |
|------|----|---------|-----------|
| `scheduled` | `processing` | Worker pick-up | Atomic update `status='scheduled' → 'processing'`, sets `claimedAt = now()`. Worker then re-validates dormancy / opt-out / rule-active (FR-010) before generating. |
| `processing` | `sent` | Redis publish | Publish success |
| `processing` | `failed` | Error | Exception caught (incl. `llm_timeout`) |
| `processing` | `failed` | Stuck-claim sweep | `claimedAt + TWIN_REENGAGE_CLAIM_TIMEOUT_MS < now()` → `failureReason='worker_timeout'` (FR-011) |
| `scheduled` | `expired` | Claim re-validation | rule no longer `isActive`, or `conversation.lastMessageAt > attempt.scheduledAt` (FR-010) |
| `scheduled` | `expired` | Inbound message | `conversation.lastMessageAt > attempt.scheduledAt` |
| `scheduled` | `opted_out` | Opt-out event | `conversation.optedOut = true` |

## Idempotency (FR-009)
Every `FollowupAttempt` has an `idempotencyKey` formatted as:
`{conversationId}:{ruleId}:{cycleIndex}`
where `cycleIndex` = the conversation's `reengagementCount` at scheduling time (deterministic per dormancy cycle — **NOT** the count of hooks already sent, which would collide across concurrent pre-send scans).

A DB **`UNIQUE(idempotencyKey)`** constraint is the dedup guard. The scanner inserts with `ON CONFLICT (idempotencyKey) DO NOTHING` — it MUST NOT rely on check-then-insert (TOCTOU race → duplicate `scheduled` rows → each passes the per-row claim → double send). The send-side guard is the atomic `scheduled → processing` claim above.

## Recovery & Retry (FR-011 — antigravity F1 / hermes C1)

A periodic **sweep** moves `processing` attempts with `claimedAt + TWIN_REENGAGE_CLAIM_TIMEOUT_MS < now()` → `failed('worker_timeout')`, freeing the conversation's cycle budget. Combined with the hook-generator's `llm.complete` timeout (`llm_timeout`), no attempt is stuck forever.

`failed` is **terminal for the cycle** — the consumed `idempotencyKey` (with its `cycleIndex`) is NOT retried in-cycle (one hook attempt per dormancy cycle; deliberate tradeoff vs retry-storms / extra sends to a dormant user). A fresh cycle (new `cycleIndex` after `needsReengagement` reset on inbound) re-evaluates eligibility.
