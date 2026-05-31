# SpecKit Review: 003-script-funnels

**Reviewer**: antigravity
**Reviewed at**: 2026-05-30T10:55:00Z
**Commit**: 5171fbd2a8ae972ee5967ee80a39912bc15f3349
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/funnel-api.yaml, research.md, quickstart.md

## Summary

This is a high-quality port of a legacy engine. The architectural choice to split definitions from immutable versions is the correct way to handle in-flight pinning (FR-016). The concurrency strategy (Redis locks + CAS) is solid for Node.js. The API contract is now professionally secured and validated. The trace between requirements and tasks is 100% complete.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | LOW | Performance | **Redis lock TTL might be too short for slow LLM calls.** Research §11 sets lock TTL to 500ms. If an off-script `steer` or `abstain` generation takes 5-10 seconds, the lock will expire long before the turn completes. | Ensure the lock is ONLY held during the deterministic matching and state update phase, OR increase TTL significantly if it covers the generative phase. Based on §6 code snippet, the funnel processing happens BEFORE the LLM call, so 500ms is likely sufficient for matching + DB write. |
| F2 | LOW | Data model | **`exit_stage_id` is required when `stuck_action = exit_stage` but not enforced by DB FK.** The column is nullable. | Ensure T020 includes application-level validation to reject definitions where `stuck_action = exit_stage` but `exit_stage_id` is NULL. |

## Alternative approaches considered

1. **Denormalized `active_version_id` on `funnel_definitions`.** Currently, `funnel_versions` has an `is_active` flag. To find the active version, you must query versions. A back-reference on the definition table would be faster, but `is_active` flag is standard and easier for multi-version management.

## VERDICT

```yaml
verdict: PASS
reviewer: antigravity
reviewed_at: 2026-05-30T10:55:00Z
commit: 5171fbd2a8ae972ee5967ee80a39912bc15f3349
critical_count: 0
high_count: 0
medium_count: 0
low_count: 2
```
