# SpecKit Review: 018-response-quality-rules

**Reviewer**: gemini
**Reviewed at**: 2026-06-14T19:15:00Z
**Commit**: 04b62b1a7d781cc7d631c04ea73dbe25b0401166
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/dar-pipeline-contract.md

## Summary

The feature provides a robust extension to the existing safety pipeline, allowing for dynamic quality corrections. However, the combination of high latency on the rewrite path, lack of conflict resolution for aggregated rules, and potential for duplicate event logging during retries present significant risks to performance and data integrity. The "fail-open" nature is excellent for availability but creates a compliance blind spot for "required" rules.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | **HIGH** | Performance | **Latency budget p95 < 2s is unrealistic for rewrite path.** A chain of `Semantic Detect (~800ms) -> Rewrite (~800ms) -> LLM Re-validate (~800ms)` totals ~2.4s, exceeding the NFR-2 budget. | Widen the budget for rewrite flows or implement "cheap" structural pre-checks to skip LLM re-validation when no sensitive tokens are introduced. |
| F2 | **HIGH** | Correctness | **Aggregated rewrite lacks conflict resolution.** Multiple contradictory instructions (e.g., "be formal" vs "be casual") in the same prompt will lead to non-deterministic LLM behavior. | Implement priority-based exclusion: if two rules affect the same scope and have conflicting instructions, only the highest priority rule should be included. |
| F3 | **HIGH** | Reliability | **QualityEvents lack idempotency keys.** Retries in the 015 chat-service worker will cause the DAR pipeline to re-run and push duplicate events to the Product dashboard. | Add a composite idempotency key (`messageId:ruleId:attempt`) to the `QualityEventPush` schema and ensure Product uses upsert. |
| F4 | **MEDIUM** | Scalability | **Cache reload webhook is process-local.** In a multi-instance deployment, the webhook only clears the cache on the instance that receives the request, leading to stale rules on others until TTL expires. | Use a shared cache (Redis) or a broadcast mechanism (Redis Pub/Sub) for invalidation across instances. |
| F5 | **MEDIUM** | Security | **Potential for Regex DoS (ReDoS).** Operator-defined regex patterns are compiled and run on the Engine without complexity limits. A "catastrophic backtracking" pattern could hang the Engine thread. | Implement a timeout for regex execution or use a safe regex engine (e.g., RE2) that guarantees linear time complexity. |
| F6 | **MEDIUM** | Privacy | **PII leakage in QualityEvents.** `originalText` and `rewrittenText` are sent over HTTP to Product. There is no specified redaction or retention policy for this potentially sensitive customer data. | Define a retention policy on the Product side and implement mandatory PII redaction (e.g., using a local NER model or regex) before pushing events. |
| F7 | **MEDIUM** | Compliance | **Required rules are skipped on Product downtime.** The "fail-open" strategy treats all rules as advisory. Compliance-critical rules (e.g., "don't quote price") are silently ignored if the API is down. | Add a `criticality` level to rules. If a `required` rule cannot be pulled/verified, the Engine should fallback to a safe state or flag the response. |
| F8 | **MEDIUM** | Security | **Re-validation skips Format-Injection.** While it reuses False-Promise and Identity-Guard, it misses the third structural guard. A rewrite could theoretically introduce a formatting break. | Include all three 004 structural validators in the re-validation pass; Format-Injection is regex-based and extremely cheap. |
| F9 | **LOW** | Observability | **Missing rule versioning.** QualityEvents link to `ruleId` but not a version/snapshot. Tracking performance across rule iterations will be impossible. | Include `snapshotVersion` in the `QualityEventPush` payload. |
| F10 | **LOW** | Consistency | **Plan snippet missing `messageId`.** The context snippet in `plan.md` (line 78) lacks `messageId`, which is required for events and included in the task list. | Update `plan.md` to include `messageId` in the DAR context. |

## Alternative approaches considered

- **Parallel Re-validation**: Instead of a serial chain, could we run re-validation in parallel for "advisory" rules? No, because re-validation is a gate for the rewrite. If it fails, we MUST rollback.
- **Rule Pre-compilation**: To mitigate F5, rules could be pre-compiled and "vetted" on the Product side before being made available to the Engine.

## VERDICT

```yaml
verdict: HIGH
reviewer: gemini
reviewed_at: 2026-06-14T19:15:00Z
commit: 04b62b1a7d781cc7d631c04ea73dbe25b0401166
critical_count: 0
high_count: 3
medium_count: 5
low_count: 2
```
