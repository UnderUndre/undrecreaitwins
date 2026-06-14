# SpecKit Review: 018-response-quality-rules

**Reviewer**: claude
**Reviewed at**: 2026-06-14T15:58:49Z
**Commit**: 6121e121f577118f3de02c9a7c81d49823402f35
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/dar-pipeline-contract.md

> ⚠️ **CONFLICT OF INTEREST — read before counting this toward the gate.** This `claude` review was
> produced by the **same agent that authored 018's spec/plan/tasks** in this session. It is a rigorous
> *self-review*, NOT an independent external review. Constitution Principle VI requires **≥2 distinct
> EXTERNAL reviewers** (gemini / glm / codex / antigravity / copilot run from those tools). **Do NOT
> count `claude.md` as one of those two.** Treat this as a pre-external-review hardening pass.

## Summary

The 018 spec is unusually complete (3 clarify rounds, 15 FRs, full plan + tasks + data-model + contract)
and the core boundary (DAR *after* 004, fail-open, never block reply) is sound. The headline weaknesses
are **physics, not consistency**: the p95<2s latency budget collides with a serial LLM chain on the
rewrite path; aggregated rewrite has no contradiction-resolution; and event push has no idempotency under
the 015 retry worker. None block baseline functionality, but three are real rework risks before implement.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Performance | **p95<2s budget likely unachievable on the rewrite path.** Worst-case rewrite-mode flow is *serial LLM*: semantic/pattern detect (rewrite-mode, NOT skippable) ~800ms → rewrite ~800ms → re-validation false-promise (LLM) ~800ms ≈ **2.4s > 2s** (plan.md:20, spec NFR-2/FR-013). The FR-013 escape valve ("skip lowest-priority **score-mode** semantic") does NOT relieve the rewrite-mode chain. | Measure before committing to <2s. Either widen the budget for the rewrite path, make re-validation conditional (skip false-promise LLM when rewrite touched no promise-like spans), or cap rewrite-mode semantic detectors separately. |
| F2 | HIGH | Design / correctness | **Aggregated rewrite has no intra-pass conflict resolution.** Aggregator sorts by priority + caps ≤4 (T007), then rewriter jams all instructions into ONE prompt (T011). Two contradictory rewrite rules ("be formal" vs "be casual for Avito") both land in the prompt → contradictory instructions → nondeterministic output. Priority *order* ≠ contradiction *resolution*. (Same unaddressed axis as 019's content-precedence gap.) | Define precedence on conflict (highest-priority instruction wins; lower-priority contradicting instruction dropped + logged), or detect+flag contradictions. Add an aggregator test with conflicting instructions. |
| F3 | HIGH | Reliability / idempotency | **QualityEvent push has no idempotency key → retries double-count.** 015 ships a provider-retry worker that re-runs `complete()`. If DAR re-runs on a retried turn, `event-push-client` (T004, fire-and-forget) pushes the same events again → duplicate rows in Product → skewed calibration dashboard. No dedup key specified. | Add idempotency key (`messageId:ruleId:attempt` or a turn UUID) to `QualityEventPush`; Product upserts. Also state explicitly whether DAR re-runs on chat-service retry. |
| F4 | MEDIUM | Reliability / scale | **Cache + reload webhook assume single process.** `rule-cache` is an in-memory `Map` (T003); the reload webhook (T005) invalidates only the **receiving instance**. Multi-instance deploy → other instances serve stale rules until 60s TTL after an operator edit. Not flagged as a constraint. | Document the single-instance assumption explicitly, OR broadcast invalidation (Redis pub/sub), OR accept+document TTL-bounded staleness across instances. |
| F5 | MEDIUM | Security / privacy | **QualityEventPush ships `originalText` + `rewrittenText` (customer PII) to Product over HTTP; no redaction / retention / encryption policy.** (spec Key Entities, FR-009.) 016's analogous `PolicyBlockEvent` got explicit encryption + 90d retention; 018 left the event payload unspecified for PII. | Define PII handling for the event payload: TLS-in-transit (assumed — state it), at-rest/retention policy on the Product side, optional truncation/redaction or per-tenant opt-out. |
| F6 | MEDIUM | Edge case | **Re-validation skips format-injection (1 of 3 structural 004 guards).** FR-007 / re-validator (T012) runs false-promise + identity-guard only. A rewrite can re-introduce a format-injection that 004 caught on the original. "Skip non-critical" is inconsistent — why are 2/3 critical post-rewrite but not the 3rd? | Justify the exclusion explicitly, or include format-injection in re-validation (it's regex-cheap — near-zero cost, closes the gap). |
| F7 | MEDIUM | Failure mode | **Fail-open silently drops compliance-critical rewrite rules.** Product down → DAR skipped → reply without custom rules (FR-014/NFR-3, plan:151). Fine for advisory tone rules, but a rewrite rule may be legal/compliance-critical ("never quote a price", "never name competitor X"). No "must-run" vs advisory distinction → silent compliance exposure. (004 structural guards still run, so the safety *baseline* holds.) | Add optional `enforcement: 'advisory' \| 'required'` on rules; `required` + Product-down → defined degrade (safe-fallback / flag / hold), not silent skip. |
| F8 | MEDIUM | Security | **`rewriteInstruction` is operator-authored free text injected into an LLM prompt (T011) — prompt-injection via rule.** A careless/compromised operator rule could steer the rewriter to leak context or emit unsafe output; re-validation only checks false-promise + identity-guard, not instruction abuse. | Document the operator trust boundary. Consider wrapping operator instructions in a delimited/escaped block in the rewrite prompt; rely on 004 re-validation as the backstop and say so. |
| F9 | LOW | Observability | **QualityEvent lacks rule version / snapshotVersion.** Events reference `ruleId` but not which version fired; after an operator edits a rule mid-stream, the calibration dashboard can't attribute events to the rule version that produced them. | Add `snapshotVersion` (or `ruleVersion`) to `QualityEventPush`. |
| F10 | LOW | Consistency | **`messageId` missing from plan's DAR context snippet.** plan.md:78-83 context = `{ tenantId, personaId, conversationId, rawUserMessage }` (no `messageId`), but tasks T015:207 includes `messageId` and `QualityEventPush` requires it. Plan snippet would fail to build events. | Align plan snippet with tasks T015 — `messageId` must be in the DAR context. |

## Alternative approaches considered

- **Re-validation cost (F1)**: instead of always running the false-promise LLM judge post-rewrite, gate it on a cheap structural pre-check (did the rewrite introduce promise-like tokens / new numerals / new commitments vs the pre-DAR text?). Skips the LLM call on the common case where the rewrite only changed tone — recovers most of the 2s budget. Worth weighing vs "always 1 LLM re-validate".
- **Aggregation conflict (F2)**: an alternative to one combined rewrite prompt is **sequential per-rule rewrite in priority order** (each rule rewrites the previous output). Resolves contradiction deterministically (later/lower-priority can't undo higher-priority) but costs N LLM calls instead of 1 — directly trades against F1's latency. The spec picked single-pass for cost; flag that this forecloses clean conflict resolution. Author should weigh, not necessarily switch.

## VERDICT

```yaml
verdict: HIGH
reviewer: claude
reviewed_at: 2026-06-14T15:58:49Z
commit: 6121e121f577118f3de02c9a7c81d49823402f35
critical_count: 0
high_count: 3
medium_count: 5
low_count: 2
note: >
  Self-review by the spec author — does NOT satisfy the ≥2 EXTERNAL reviewer requirement
  of Principle VI. Verdict HIGH driven by F1 (latency budget vs serial LLM chain),
  F2 (no rewrite-conflict resolution), F3 (no event idempotency under retry). All are
  pre-implement rework items, not baseline blockers.
```
