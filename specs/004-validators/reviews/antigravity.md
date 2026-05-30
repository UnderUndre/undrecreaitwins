# SpecKit Review: 004-validators

**Reviewer**: antigravity
**Reviewed at**: 2026-05-30T05:05:00Z
**Commit**: HEAD
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, context-for-review.md

## Summary

The `004-validators` specification offers a solid, well-structured approach to porting legacy validators into the engine's chat path, with commendable attention to tenant isolation, latency bounding, and fail-open/closed policies. However, a critical contradiction exists in the failure isolation policy that could cause unsafe, unauthorized promises to be delivered to customers if database persistence fails. Furthermore, there is a logical flaw in how "total rewrite" and "append" remediations compose.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | CRITICAL | Failure Mode / Safety | **FR-016b allows unsafe messages to reach customers**. The spec states: "or run-persistence failing after a mutation → the original, unmutated reply is delivered". If the false-promise validator detects an unauthorized commitment and appends a disclaimer, but the DB insert into `validator_runs` fails, delivering the *unmutated* reply means sending the false promise directly to the customer. This defeats the P1 business requirement. | If a reply was flagged as unsafe and mutated, but the mutation cannot be durably recorded, the system MUST NOT deliver the original unsafe reply. It should fail the chat request entirely (e.g., HTTP 500) or deliver a safe system fallback. |
| F2 | HIGH | Composition / Logic | **Total Rewrite obliterates earlier appends**. FR-017 and T016 attempt to solve composition by running REWRITE validators last, reasoning that "each REWRITE validator sees the accumulated text". However, FR-008 dictates that identity-guard *replaces the entire response* with a fixed `fallbackMessage`. Seeing the accumulated text does not matter if the code simply returns the locked template. The disclaimer appended by false-promise will be lost. | Change the orchestrator to manage mutation composition (e.g., apply rewrite *then* apply any pending appends), OR explicitly require the identity-guard (T015) to preserve and re-append any existing disclaimers found in the incoming text to its `fallbackMessage`. |
| F3 | MEDIUM | Edge Case | **Format-injection strip can produce empty inbound messages**. While FR-019 provides an empty-output guard for replies, there is no empty-input guard for US3. If a user message consists entirely of injection artifacts, `format-injection.ts` will strip it to an empty string. Passing an empty string to the generation LLM may cause provider errors or hallucinated responses. | Implement an empty-input guard for inbound messages after stripping. If the resulting string is empty/whitespace, either halt the generation pipeline and return a system prompt error to the user, or drop the message entirely. |
| F4 | MEDIUM | Stakeholder Clarity | **Ambiguous `applyToTier1` scope**. FR-008 and T014 mention the `applyToTier1` flag for identity-guard to "catch identity questions during the greeting stage". It is unclear if this flag disables the guard entirely for Tier 2+ or alters its behavior. If disabled, how are identity leaks in Tier 2 handled? | Clarify in the spec and `identity-and-provider-guard.ts` tasks whether `applyToTier1: true` means the guard *only* runs in Tier 1, or if it runs everywhere but uses stricter heuristics in Tier 1. |

## Alternative approaches considered

To resolve F2 (Composition), instead of sequential string-passing, validators could return an array of `ProposedMutation` objects. The orchestrator would then compile these: if there is a `RewriteMutation`, it takes precedence for the base text, and any `AppendMutation` objects are appended afterward. This separates the generation of mutations from their application, avoiding ordering paradoxes.

## VERDICT

```yaml
verdict: CRITICAL
reviewer: antigravity
reviewed_at: 2026-05-30T05:05:00Z
commit: HEAD
critical_count: 1
high_count: 1
medium_count: 2
low_count: 0
```
