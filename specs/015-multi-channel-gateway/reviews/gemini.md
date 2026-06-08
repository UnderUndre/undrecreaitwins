# SpecKit Review: 015-multi-channel-gateway

**Reviewer**: gemini
**Reviewed at**: 2026-06-09T14:40:00Z
**Commit**: e76da1c1b4a69046ffd0dd2296f38e00cafc9952
**Artifacts reviewed**: spec.md, plan.md, tasks.md, .specify/memory/constitution.md

## Summary

The Multi-Channel Gateway spec is a massive expansion of the twin's reach. The design correctly identifies the existing `ChannelAdapter` infrastructure in `twin-engine` as the leverage point. However, the discovery that the "sole gate" (Validator 004) is currently bypassed by the reengagement service is a **CRITICAL** architectural breach that must be closed before this feature scales. Furthermore, the cross-repo nature of this feature introduces significant complexity in branch management and implementation discipline.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | **CRITICAL** | Architecture | **Gate Breach (CL-A6)**: The `reengagement` service currently bypasses the response validators. Scaling to 13+ channels without fixing this creates an unmanageable safety risk. | Fix the `reengagement` bypass (Gate-0 T006) as a hard prerequisite for any new channel implementation. |
| F2 | **CRITICAL** | Constitution | **Principle IX Violation**: The implementation target is a different repository (`twin-engine`), but the planning artifacts are here in `ai-twins`. Implementation branches must exist in the code-hosting repo. | Re-home the 015 spec folder to `undrecreaitwins/specs/` before calling `/speckit.implement`. |
| F3 | **HIGH** | Security | **Plaintext Credentials (CL-A1)**: Channel credentials are currently stored in plaintext in the DB. This is a massive exposure risk for 15 platforms. | Prioritize T005 (KmsProvider ciphertext column) and ensure the migration handles existing tokens safely. |
| F4 | **HIGH** | Reliability | **Webhook Idempotency**: While FR-006 mentions idempotency, the plan for webhook channels (US3) doesn't specify the storage mechanism for `message_id` to prevent duplicate processing on redelivery. | Explicitly define a Redis-based short-term "seen_messages" set with TTL for each webhook adapter. |
| F5 | **MEDIUM** | Performance | **Consumer Sprawl**: Each of the 15+ channels being its own process will lead to significant memory overhead in a standard deployment. | Research if groups of low-traffic channels can share a single consumer process with internal routing for better resource utilization. |
| F6 | **MEDIUM** | Ops | **Secret Rotation**: The spec defines creation/list/read but lacks a process for updating/rotating credentials for active channels without downtime. | Add a task for a "rotate_credentials" flow that ensures new connections use the new secret while old ones drain. |

## Alternative approaches considered

*   **Hermes Sidecar (Option C)**: Rejected because it requires a "tenant-aware" custom build of Hermes, which is more complex than porting the protocol logic into the native TypeScript environment.
*   **Central Gateway Service**: Considered a single "Gateway" service for all channels, but rejected in favor of the existing "Adapter-per-package" pattern to maintain strict isolation and independent scalability of noisy channels (Telegram/WhatsApp).

## VERDICT

```yaml
verdict: CRITICAL
reviewer: gemini
reviewed_at: 2026-06-09T14:45:00Z
commit: e76da1c1b4a69046ffd0dd2296f38e00cafc9952
critical_count: 2
high_count: 2
medium_count: 2
low_count: 0
```
