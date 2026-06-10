# SpecKit Review: 016-marketplace-comms

**Reviewer**: gemini
**Reviewed at**: 2026-06-09T15:30:00Z
**Commit**: 9e30d79147fca33e4a843e450f2f0d322244c1df
**Artifacts reviewed**: spec.md, plan.md, tasks.md, .specify/memory/constitution.md

## Summary

The Marketplace Comms feature correctly identifies and isolates the high-risk domain of platform-bound messaging. The decision to enforce a "restricted mode" (disabling funnels and reengagement) is technically sound and necessary for seller safety. However, the `policy-engine` module, while correctly identified as a shared dependency, lacks a clear enforcement mechanism at the database/registry level to prevent a "bare" marketplace channel from being accidentally enabled without its accompanying policy profile.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | **CRITICAL** | Architecture | **Fail-Closed Enforcement**: While FR-004 states the channel won't start without a policy profile, the plan (T012/T013) doesn't specify *how* the channel registry or orchestrator validates this at boot time. | Implement a `MarketplaceRegistry` that asserts the existence of a valid `PolicyProfile` for the specific channel type before allowing the adapter to initialize. |
| F2 | **HIGH** | Compliance | **Funnel Leakage via RAG**: Disabling funnel-redirect logic (FR-005) is good, but if the RAG context (005) contains "off-platform" instructions or contact info in the persona documents, the model may still generate prohibited content. | Ensure the `policy-engine` is applied *after* the LLM response is generated, regardless of the prompt source. |
| F3 | **HIGH** | Performance | **Poller Backoff Exhaustion**: Marketplace APIs (especially WB) have draconian rate limits. The plan for "backoff" (FR-006) doesn't specify what happens if the backoff window exceeds the `health()` check timeout. | Define a maximum "poller lag" threshold in `health()` that differentiates between "normal backoff" and "adapter stuck/blocked". |
| F4 | **MEDIUM** | Reliability | **Order-API Degradation UX**: FR-010 allows for "reply by text" if the order-API is down. However, the model might need to know *why* it doesn't have order context to avoid hallucinating status. | Inject a system-level "Context Note" into the prompt when the order-API fails, telling the model to inform the buyer that order details are temporarily unavailable. |
| F5 | **MEDIUM** | Security | **Order Context Cache Key**: Redis SET NX for idempotency (FR-007) is per message, but the order context cache (T011) must be per-tenant/per-order to prevent cross-tenant data leakage. | Explicitly define the Redis cache key format for order context as `cache:marketplace:order:<tenantId>:<postingId>`. |
| F6 | **LOW** | Polish | **Policy Audit Log Size**: NFR "Audit of every blocked response" may produce high-volume logs if a model consistently fails a policy. | Define a structured `PolicyBlockEvent` with a summary of the violation reason to facilitate rapid tuning of the prompt/persona. |

## Alternative approaches considered

*   **Integrated Q&A only**: Rejected (CL-016-1). Providing a full (though restricted) twin experience offers significantly more value than a simple FAQ bot.
*   **Prompt-based Compliance**: Rejected (DL-4). Relying solely on prompts to follow marketplace ToS is too unreliable for a business-critical risk like a platform ban. The dual-gate (Disabled Features + Policy Validator) is the correct approach.

## VERDICT

```yaml
verdict: MEDIUM
reviewer: gemini
reviewed_at: 2026-06-09T15:35:00Z
commit: 9e30d79147fca33e4a843e450f2f0d322244c1df
critical_count: 1
high_count: 2
medium_count: 2
low_count: 1
```
