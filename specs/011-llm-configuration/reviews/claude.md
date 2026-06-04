# SpecKit Review: 011-llm-configuration (Engine)

**Reviewer**: claude
**Reviewed at**: 2026-06-04T14:30:00Z
**Commit**: 821d438d5e217e43a9484a9b84ec93ae4c1548bd
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/llm-provider.contract.md, research.md, quickstart.md, constitution.md, + cross-reference with ai-twins/011-llm-configuration (spec.md, plan.md, tasks.md, contracts/bff.contract.md)

## Summary

This is an unusually well-bounded feature spec — the runtime↔admin split is crisp, the dependency on 010 (hermes-executor) is honestly flagged with a gate (T000-LLM), and the security posture (SSRF guard, encrypted keys, write-only key contract, tenant isolation) is thorough. The headline strength is the **durable-retry on same provider (no silent model-swap)** design decision, which prevents a real operational footgun. The headline weakness is that **the T000-LLM gate (can Hermes ACP accept per-session model/provider override?) is the architectural keystone, and both the plan and tasks branch heavily on its outcome — but no fallback timeline or alternative is scheduled if the gate fails**. The entire injection strategy (DD-HXL-002) is conditional, and the "fallback B" (pool keyed by config) is described but not tasked.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Hidden assumption | **T000-LLM gate outcome has no tasked fallback.** DD-HXL-002 defines Strategy A (per-session override) and Fallback B (pool-keyed-by-config), but tasks only implement A (T004 injects `model`/`provider` into ACP session). If T000-LLM fails, there are zero tasks for implementing B. The plan mentions B as "bounded, since few distinct providers per deployment" but provides no sizing estimate or pool-eviction strategy. | Add a conditional task block: if T000-LLM fails → T004B (pool-keyed-by-config with provider-config-hash as pool key, eviction/limits). Define a max-pool-size per tenant (e.g., 5 distinct configs) and an eviction policy. |
| F2 | HIGH | Missing edge case | **Key rotation during an in-flight Hermes agent loop.** FR-008 says config changes take effect on "subsequent turns and queued retries" — but what about a turn that's currently executing? The Hermes ACP session is already running with the old key. If the provider rejects mid-loop (key revoked), the agent loop may partially fail. The spec says "in-flight synchronous runs are not affected" but doesn't define what happens if the in-flight turn *fails* due to the rotated key — does it retry with the new key or dead-letter? | Clarify: if an in-flight turn fails mid-loop due to a key that was rotated during execution, the retry should use the **current** effective config (new key). This is a special case of FR-008 that needs explicit handling. |
| F3 | HIGH | Security | **SSRF allow/deny policy is specified but not mechanically defined.** FR-004 says "reject loopback/private/link-local/cloud-metadata" but the contract (§ssrf-guard) lists CIDRs to block (127.0.0.0/8, 10.0.0.0/8, etc.) without specifying: (a) what about IPv6 loopback (::1) and IPv6 link-local (fe80::/10)? (b) what about DNS rebinding (URL resolves to a private IP at request time)? (c) is the URL resolved before checking, or is the hostname checked? | Extend the SSRF guard spec: resolve DNS first, then check the resolved IP against the deny list. Add IPv6 ranges. Consider DNS rebinding mitigation (re-check after redirect). The contract should specify this as resolve-then-check, not just string-match on the URL. |
| F4 | MEDIUM | Logical consistency | **T006 (durable-retry worker) and T009 (SSRF guard) have no dependency on T004 (injection), but T004 depends on T000-LLM.** If T000-LLM fails and Strategy B is used, T004 changes shape entirely (pool routing vs session injection). T006 and T009 are independent of this, but T011 (wire into executor) is not — it needs the final injection strategy. The dependency graph doesn't reflect this conditional branching. | Add a note in the dependency graph: T011 depends on T004 outcome (A vs B). If B is needed, T004 and T011 scope changes. |
| F5 | MEDIUM | Failure modes | **KMS unavailability during key decryption.** The plan uses KMS envelope encryption (research.md §c). If KMS is down at injection time, the key cannot be decrypted → the turn fails → durable-retry. But the retry will also fail if KMS is still down. There's no KMS-specific fallback or circuit breaker specified. | Add a KMS health-check to the engine health endpoint. Define behavior: if KMS is degraded, queue turns (don't dead-letter immediately), and alert. Consider caching decrypted keys in memory with a short TTL (trade-off: security vs availability). |
| F6 | MEDIUM | Performance | **Pool-keyed-by-config (Fallback B) has no upper bound defined.** The plan says "bounded, since few distinct providers per deployment" but doesn't define a hard limit. A tenant with 50 assistants each using a different provider would need 50 warm Hermes processes. Memory/CPU impact is unestimated. | Define `MAX_DISTINCT_CONFIGS_PER_TENANT` (suggest 5-10) and a rejection policy (LRU eviction or error on config save). Document the expected concurrent warm-pool size. |
| F7 | MEDIUM | Hidden assumption | **"Platform default" is referenced throughout (FR-001 resolution chain) but never defined.** What is the platform default provider/model? Is it OmniRoute? A hardcoded value? An env var? The resolution chain is `assistant → tenant → platform default` but the last link is opaque. | Define the platform default explicitly in spec or contract: is it `HERMES_DEFAULT_MODEL` env var? OmniRoute's configured default? A database row? This matters for the fallback behavior when all overrides are cleared (FR-011/FR-012). |
| F8 | MEDIUM | Missing edge case | **Concurrent config updates to the same assistant.** Two admins editing the same assistant's provider config simultaneously — last-write-wins? Optimistic locking with version? The data model has no version column on `LLMProviderConfig`. The contract doesn't mention idempotency or conflict resolution for config updates. | Add an `updatedAt` + optimistic concurrency (ETag or version) to the config update endpoint. Or explicitly state last-write-wins if that's acceptable. |
| F9 | LOW | Stakeholder clarity | **"Durable-retry" and "dead-letter" are used in the spec but not defined in the glossary.** For a non-technical stakeholder, "dead-letter" is opaque. The glossary defines "BYOK" and "effective config" but not these operational terms. | Add to glossary: "Durable-retry — automatic re-execution with backoff; dead-letter — terminal state after retry window exhausted, operator alerted." |
| F10 | LOW | Alternative approaches | **The spec doesn't consider a proxy/gateway model for BYOK.** Currently, the engine injects the tenant's key directly into Hermes, which makes the outbound call. An alternative: engine proxies the LLM call itself (engine holds the key, makes the fetch, returns the response to Hermes). This would eliminate the pooled-process isolation concern entirely (key never leaves the engine), at the cost of an extra network hop. Not a recommendation to change — just flagging as unconsidered. | No action needed for MVP. Flag for future: if pool isolation proves too complex, a proxy model simplifies the security model at the cost of latency. |
| F11 | LOW | Constitution alignment | **Principle VI (cross-AI review) — this review partially addresses it**, but a second external reviewer (gemini, codex) is still needed before `/speckit.implement`. | Ensure at least one more reviewer completes before proceeding. |

## Alternative approaches considered

1. **Engine-as-proxy (vs direct Hermes injection)**: Instead of injecting the tenant's key into the Hermes ACP session, the engine could proxy all LLM calls itself. Hermes would call back to the engine (via the existing MCP tool-gateway) for every LLM completion, and the engine would make the outbound call with the tenant's key. This eliminates the cross-tenant key isolation problem in the warm-pool entirely, but adds latency (extra hop) and requires Hermes to support a "remote LLM" mode. The spec doesn't discuss this trade-off.

2. **Config-as-env-var (vs DB entity)**: For the MVP with only custom OpenAI-compatible providers, the config could be passed as environment variables to the Hermes subprocess at spawn time, rather than stored as a separate DB entity. Simpler (no new tables, no encryption infrastructure needed beyond process env), but loses audit trail, can't do test-connection without spawning, and doesn't support the tenant-default resolution chain. The spec implicitly chose DB entity — reasonable, but the trade-off isn't discussed.

## VERDICT

```yaml
verdict: MEDIUM
reviewer: claude
reviewed_at: "2026-06-04T14:30:00Z"
commit: 821d438d5e217e43a9484a9b84ec93ae4c1548bd
critical_count: 0
high_count: 3
medium_count: 5
low_count: 3
```
