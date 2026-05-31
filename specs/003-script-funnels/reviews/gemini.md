# SpecKit Review: 003-script-funnels

**Reviewer**: gemini
**Reviewed at**: 2026-05-30T10:45:00Z
**Commit**: 5171fbd2a8ae972ee5967ee80a39912bc15f3349
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/funnel-api.yaml, research.md, quickstart.md

## Summary

The specification and plan are exceptionally robust, demonstrating deep consideration for distributed systems challenges. The move to a definition/version split for funnels perfectly addresses the pinning requirements. The addition of machine-readable resolution criteria and explicit scoring weights removes the previous ambiguity. Security and concurrency (CAS + Redis locks) are now first-class citizens in the design.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | LOW | Polish | **Task T028 (Redis lock) is in Phase 6 but is critical for US1 concurrency.** While serialized turns are listed as a safety requirement, the task is deferred to the final phase. | Consider moving T028 to Phase 2 (MVP) to ensure concurrency is handled from the start, especially for SC-002 (reproducibility). |
| F2 | LOW | Polish | **Slot verification dead-letter table not in data model.** Research §4 mentions a `slot_verification_failures` table for operator review, but it's not listed in `data-model.md`. | Add `slot_verification_failures` to `data-model.md` for completeness. |

## Alternative approaches considered

1. **Denormalized Fragment Score Cache.** For extremely high-volume personas, a Redis cache of `(funnel_version_id, message_hash) -> fragment_id` could bypass the scorer entirely for repeated exact-match messages. Given the 100ms budget and in-memory LRU cache, this is likely overkill but could be a future optimization.

## VERDICT

```yaml
verdict: PASS
reviewer: gemini
reviewed_at: 2026-05-30T10:45:00Z
commit: 5171fbd2a8ae972ee5967ee80a39912bc15f3349
critical_count: 0
high_count: 0
medium_count: 0
low_count: 2
```
