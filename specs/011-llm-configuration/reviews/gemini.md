# SpecKit Review: 011-llm-configuration (Engine)

**Reviewer**: gemini
**Reviewed at**: 2026-06-04T15:10:00Z
**Commit**: 80c25ee891b438093da1c020912df53383e5ddfc
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, quickstart.md

## Summary

The runtime specification for the LLM Provider Configuration establishes a robust mechanism for supporting BYOK models while retaining the Engine as the source of record. The fallback strategy for injection (Strategy B: pooling by config) and the SSRF guards are theoretically sound, but lack critical implementation details regarding resource cleanup and HTTP client specifics, which could lead to memory leaks or security vulnerabilities.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Performance & Scale | **Warm-pool exhaustion and GC (Strategy B)**. If gate T000-LLM forces Strategy B (pool keyed by config), the spec does not define an eviction policy (e.g., LRU, TTL) for the warm processes. A tenant rapidly changing their config, or many tenants creating unique configs, will spawn new isolated Hermes processes. Without garbage collection of orphaned or idle processes tied to stale configs, the engine (C3) will quickly exhaust its memory budget. | Add an explicit requirement and task for an eviction/GC policy (e.g., idle TTL) for the warm-pool manager, especially if Strategy B is chosen. |
| F2 | HIGH | Security | **SSRF DNS Pinning Implementation**. Task T006 correctly identifies "DNS-resolve-and-pin" as the defense against DNS rebinding. However, native Node.js HTTP clients (`fetch`, `axios`) do not natively support connecting to a specific IP while sending a different `Host` header and maintaining proper TLS SNI. If implemented naively, this will either break HTTPS or fail to prevent rebinding. | Specify the exact mechanism or library (e.g., custom `https.Agent` with `lookup` override) that will be used to enforce IP pinning while maintaining valid TLS SNI. |
| F3 | MEDIUM | Edge Case | **Test-Connection Key Merge**. When the BFF proxies a `test-connection` request during a config edit, the `apiKey` might be omitted (since it is write-only on the UI). The Engine's `test-connection` endpoint must handle this by fetching the existing configuration, decrypting the stored key, and merging it with the incoming payload to perform the test. Task T012 does not mention this merge logic. | Update Task T012 and the internal API contract to explicitly require fetching and decrypting the existing key if the `test-connection` payload omits the `apiKey`. |
| F4 | MEDIUM | Failure Modes | **KMS Outage during Injection**. The spec defines durable-retry for *provider* outages (FR-005). However, it is unclear what happens if the *KMS* system is down when the engine attempts to decrypt the API key at injection time. | Clarify in the spec whether a KMS decryption failure at injection time triggers the same BullMQ durable-retry loop as a provider failure, or if it hard-fails. |

## Alternative approaches considered

For SSRF protection, instead of building a complex Node.js DNS-pinning HTTP agent, an alternative is to route all egress LLM calls through a dedicated, isolated egress proxy (like Envoy or a lightweight Squid instance) that enforces the allow/deny rules and handles DNS resolution safely at the infrastructure level. This removes the SSRF complexity from the Node.js application logic.

## VERDICT

```yaml
verdict: HIGH
reviewer: gemini
reviewed_at: 2026-06-04T15:10:00Z
commit: 80c25ee891b438093da1c020912df53383e5ddfc
critical_count: 0
high_count: 2
medium_count: 2
low_count: 0
```