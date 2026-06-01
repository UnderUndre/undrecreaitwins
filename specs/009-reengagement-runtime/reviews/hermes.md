# SpecKit Review: 009-reengagement-runtime

**Reviewer**: hermes
**Reviewed at**: 2026-06-01T14:30:00Z
**Commit**: bd65b93f5c2d147ffb3d7e336454d14f5893d7cd
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, research.md, quickstart.md, contracts/{scanner,hook-generator,delivery,attempt-state-machine}.contract.md

## Summary

The Product↔Engine split is clean, the idempotency design is solid (`UNIQUE(idempotencyKey)` + `cycleIndex = reengagementCount` + atomic claim — a genuine improvement over check-then-insert), and the DB-status-claim worker pattern is a defensible architectural choice. However, the design has a fatal gap in worker crash recovery: a `processing`-stuck attempt is unrecoverable without manual intervention. Beyond that, there are significant blind spots around multi-rule dedup, an undefined `conditions` schema, an untasked `minInterval` constraint, and no concurrency/deployment model that could actually meet SC-002 at scale. The research.md contains stale sections contradicting the final design.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| C1 | CRITICAL | Failure mode | **No stuck-processing recovery.** If a worker crashes/OOMs after the atomic `scheduled→processing` claim, the attempt remains `processing` forever. The scanner's `ON CONFLICT DO NOTHING` won't re-schedule because the idempotency key is already consumed. No timeout sweep, no stalled-job detection, no max-retry counter exists in any artifact. The attempt is dead — and with `maxAttempts` enforcement, the conversation gradually loses its budget to phantom failed attempts. | Add a recovery mechanism: (a) a `processing` timeout (e.g., 5 min) after which another worker can re-claim, or (b) a periodic sweep that moves stale `processing` → `failed` with `failureReason='worker_timeout'`, freeing the slot. The `attempt-state-machine.contract.md` should define a `processing → failed` transition triggered by a `claimedAt + timeout < now()` condition. |
| H1 | HIGH | Edge case | **Multiple active rules hit the same conversation → multiple simultaneous hooks.** The scanner iterates all active rules per tenant and queries dormant conversations for each. If 3 rules match conversation X, 3 `FollowupAttempt` rows are scheduled in the same scan. Under `maxAttempts` per-rule enforcement, this is "correct" per the letter of FR-006 — but the *user* receives 3 hooks in the same minute. FR-006 mentions a `minInterval` between hooks "per conversation across all rules," but this constraint has no task (see H3). | Either: (a) add cross-rule dedup/throttling in the scanner (schedule at most 1 attempt per conversation per scan), or (b) implement `minInterval` enforcement (H3) so the worker delays sends that are too close together. Document the intended UX: should a user ever receive 2 hooks from 2 different rules within the same hour? |
| H2 | HIGH | Missing spec | **`FollowupRule.conditions` (JSONB) has no schema or evaluation logic.** spec FR-002 says the scanner reads `conditions` to drive matching. data-model.md shows `conditions: JSONB` with one example (`{"source": "telegram"}`). But no artifact defines: what fields are valid? What operators? JSON containment (`@>`) or string equality? Can conditions reference conversation fields beyond `source`? The scanner (T009/T010) cannot be implemented without this. | Define a `conditions` schema in spec.md or a companion contract. Minimum: list of filterable fields, operator set (eq, in, contains), and evaluation semantics. Start small (channel source + conversation tags), document as extensible. |
| H3 | HIGH | Coverage gap | **`minInterval` (cross-rule minimum between hooks per conversation) is specified in FR-006 and research.md §f but has ZERO tasks.** Only per-rule backoff (T018) and per-rule maxAttempts (T019) are tasked. Without `minInterval`, a conversation matching multiple rules can receive hooks every few seconds if the rules have short backoff schedules — defeating the anti-spam intent of FR-006. | Add a task: enforce a configurable minimum interval (e.g., 4 hours) between *any* two hooks for the same conversation, across all rules. Evaluate at scanner scheduling time AND at worker delivery time. |
| H4 | HIGH | Performance | **No worker concurrency/deployment model.** SC-002 targets p95 < 2s for schedule→delivery. Under nominal load (10k conversations/run, 60s scan interval), the scanner schedules ~10k attempts in one pass. A single worker processing them sequentially at ~1s per LLM call takes ~3 hours — p95 would be measured in hours, not seconds. The plan chooses DB-status-claim over BullMQ per-attempt jobs but doesn't specify: how many workers? What concurrency limit? How to scale horizontally? | Add a deployment/concurrency spec to plan.md: e.g., "N worker processes, each claiming 1 attempt at a time, no shared lock needed due to atomic status claim." Specify a default N and a strategy for tuning against SC-002. |
| M1 | MEDIUM | Consistency | **research.md contradicts final design in two sections.** §e defines `UNIQUE(conversation_id, rule_id, scheduled_at)` — the final design uses `UNIQUE(idempotencyKey)` with `cycleIndex`. §i defines a `reengagement_status: idle | scheduled | completed | opted_out` enum field — the final design uses boolean `needsReengagement`. An implementer reading research.md first will build the wrong thing. | Update research.md §e and §i to match data-model.md, or add "SUPERSEDED — see data-model.md" headers. The research is a phase-0 artifact; stale alternatives are fine if clearly marked. |
| M2 | MEDIUM | Edge case | **`backoff` array overflow — behavior undefined.** If `maxAttempts: 10` and `backoff: [1440, 2880, 4320]` (3 entries), what's the backoff for attempts 4–10? Use last element? Linear extrapolation? No backoff? This affects the scanner's scheduling and the user experience. | Define the overflow policy: e.g., "use the last element of the `backoff` array for all subsequent attempts." Add to spec.md or data-model.md. |
| M3 | MEDIUM | Failure mode | **No timeout specified for `llm.complete()` in the hook-generator contract.** If the LLM call hangs (provider outage, network stall), the worker is blocked in `processing` indefinitely. This is a direct contributor to C1 — the stuck-processing risk isn't limited to worker crashes; slow LLM responses create the same deadlock. | Add a timeout to the hook-generator contract (e.g., 30s). On timeout, transition attempt → `failed` with `failureReason='llm_timeout'`. This is a local mitigation for C1; a global recovery sweep is still needed. |
| L1 | LOW | Stakeholder clarity | **"Hook" is used throughout but never explicitly defined.** The spec uses "hook (win-back message)", "hook content", "generated hook" — but a non-technical reader (support, PM) may not know this means "an AI-generated outbound message sent to a dormant user." | Add a one-line definition in spec.md §Overview: "A **hook** is an AI-generated outbound message sent to re-engage a dormant user." |

## Alternative approaches considered

**Redis Streams for stuck-job heartbeats**: Instead of a periodic DB sweep for stale `processing` attempts, the worker could write a heartbeat to a Redis key with TTL while processing. If the key expires, a watchdog knows the worker died. This is lighter than a DB sweep but adds a Redis dependency to the worker's hot path. For the MVP, a simple DB sweep (`processing` + `claimedAt + timeout < now()`) is more consistent with the DB-status-claim architecture.

## Cross-reference with existing reviews

- **analyze.md (PASS)**: Confirmed N1 (inbound reset untasked) — I don't duplicate it here but agree it's a real gap. My H3 (`minInterval`) is a distinct untasked requirement from the same FR-006.
- **antigravity.md (CRITICAL)**: F1 (stuck processing) — I independently confirm and expand with M3 (LLM timeout as a contributor). F2 (inbound reset) — same as analyze N1. F3 (worker re-validation) — my H1 covers the multi-rule dimension; C1 covers the crash dimension. F4 (idempotency key burns retries) — valid concern, but the design intentionally trades retry for dedup simplicity; documenting this tradeoff would suffice.

## VERDICT

```yaml
verdict: CRITICAL
reviewer: hermes
reviewed_at: "2026-06-01T14:30:00Z"
commit: bd65b93f5c2d147ffb3d7e336454d14f5893d7cd
critical_count: 1
high_count: 4
medium_count: 3
low_count: 1
```

**Rationale**: C1 (stuck-processing recovery) is a design-level gap that makes the attempt state machine incomplete — `processing` is a black hole with no exit on worker failure. This blocks baseline reliability. The HIGHs (multi-rule dedup, undefined conditions schema, untasked minInterval, missing concurrency model) are individually addressable but collectively indicate the scanner→worker pipeline needs another design pass before implementation. M1–M3 are quality/robustness concerns.
