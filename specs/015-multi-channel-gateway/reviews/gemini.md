# SpecKit Review: 015-multi-channel-gateway

**Reviewer**: gemini
**Reviewed at**: 2026-06-09T15:10:00Z
**Commit**: 9e30d79147fca33e4a843e450f2f0d322244c1df
**Artifacts reviewed**: spec.md, plan.md, tasks.md, .specify/memory/constitution.md

## Summary

The updated Multi-Channel Gateway spec is significantly more robust, addressing previous concerns regarding repo hygiene (re-home done) and architectural safety. The inclusion of CIS-specific channels (VK, Avito) and the explicit exclusion of Marketplace-comms (moved to 016) shows improved domain maturity. However, the **CRITICAL** dependency on the `reengagement` gate fix (CL-A6) remains the primary blocker; while a stopgap is planned (T006), scaling must be strictly gated on its verification. The Avito Webhook V3 authentication scheme is currently a design-time assumption that needs validation.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | **CRITICAL** | Architecture | **Gate Breach Verification**: While T006 plans a stopgap for the `reengagement` bypass, implementation MUST NOT proceed with the 13-channel rollout until this interceptor is verified by code and regression tests. | Add a specific "Verification Checkpoint" after T006 to audit the OUTBOUND path before T007. |
| F2 | **HIGH** | Reliability | **Avito Auth Uncertainty (CL-A9 / U1)**: The Avito Webhook V3 auth scheme is assumed to fit the `webhook-signature.ts` pattern, but this is unverified. If Avito uses a different mechanism (e.g. IP-allowlist-only or a proprietary challenge), it will break the generic module. | Verify Avito Webhook V3 auth requirements immediately (Research Phase 0) before implementing T032. |
| F3 | **HIGH** | Security | **Plaintext Cleanup Safety**: T005 plans to migrate plaintext credentials to ciphertext. There is a risk of data loss if the decryption round-trip isn't verified *before* the plaintext column is scrubbed or ignored. | Ensure T005 includes a "Verify-Before-Wipe" step in the SQL migration script. |
| F4 | **MEDIUM** | Performance | **Consumer Sprawl / Resource Drain**: The "one-process-per-channel" model is safe but expensive. 15 channels + MTProto sessions will cause significant OOM risk on smaller container instances. | Baseline memory usage for one adapter and define minimum system requirements for the 015 gateway rollout. |
| F5 | **MEDIUM** | Constitution | **Principle IX Branching**: Artifacts are now in the correct repo, but currently reside on `main`. | Create the `015-multi-channel-gateway` branch in `undrecreaitwins` before implementation. |
| F6 | **LOW** | Resilience | **XPENDING Monitoring**: While FR-007 and T023 address message redelivery, there is no task for alerting when the `seen:` Redis keys or `XPENDING` queue exceeds a "stuck message" threshold. | Add a task for basic observability/alerting on queue depth per channel. |

## Alternative approaches considered

*   **Generic Marketplace Channel**: Rejected. The decision to split Ozon/WB into `016-marketplace-comms` (CL-A10) is superior because it prevents the generic `ChannelMessage` contract from bloating and protects sellers from inadvertent compliance bans.
*   **MCP Transport Layer**: Rejected (CL-A11). Push vs. Pull mismatch confirms that Redis Streams is the correct pipe for high-volume gateway events.

## VERDICT

```yaml
verdict: MEDIUM
reviewer: gemini
reviewed_at: 2026-06-09T15:15:00Z
commit: 9e30d79147fca33e4a843e450f2f0d322244c1df
critical_count: 1
high_count: 2
medium_count: 2
low_count: 1
```
