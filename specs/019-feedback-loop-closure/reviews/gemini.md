# SpecKit Review: 019-feedback-loop-closure

**Reviewer**: gemini
**Reviewed at**: 2026-06-14T20:15:00Z
**Commit**: 832cad746b4e0944dc05f2922ae289b9d5b89808
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/feedback-loop-contract.md, quickstart.md

## Summary

The feature correctly addresses the missing "feedback retrieval" link in the Engine, enabling operator corrections to influence live generations. The prompt composition contract and budget allocation are well-defined. However, a significant gap exists between the observability requirements (per-message historical queries) and the proposed data model (which only tracks current conversation state).

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | **HIGH** | Observability | **Data Model vs Endpoint Gap**: `GET /v1/internal/retrieved-feedback` expects per-message historical data (via `messageId`), but the data model only provides the *current* state in `conversation_feedback_states`. | Add a historical logging table (e.g., `message_applied_feedback`) to store which IDs were applied to which message, or clarify that the endpoint only proxies Langfuse (contradicting the "without coupling" goal). |
| F2 | **MEDIUM** | Edge Case | **Proactive retrieval query**: `spec.md` defines retrieval based on "Last user message". In proactive flows (bot starts), no user message exists. | Define a fallback query (e.g., persona topic or empty embedding) for bot-initiated messages. |
| F3 | **MEDIUM** | Logic | **Dedup Reset in long funnel stages**: Stage-transition reset (FR-006) might lead to feedback "fatigue" being avoided too well—if a stage lasts 50 messages, a lesson from message 1 may be lost by message 10. | Add a message-count based reset *even within* a stage (e.g., reset every 5 messages regardless of stage). |
| F4 | **MEDIUM** | Performance | **pgvector scoring efficiency**: The formula uses `1 - (<=>)`. If vectors from TEI (BGE-M3) are pre-normalized, using inner product `<#>` can be faster in some Postgres versions. | Verify if TEI vectors are normalized and consider using inner product if performance becomes an issue during scale-up. |
| F5 | **LOW** | Consistency | **`messageId` availability**: Integration T008 uses `messageId` but the data model for `conversation_feedback_states` doesn't link to individual messages. | Ensure `messageId` is passed correctly from `chat-service.ts` to the retrieval/logging logic. |

## Alternative approaches considered

- **Sliding Window Dedup**: Instead of resetting arrays, use a fixed-size buffer of the last N applied IDs. This avoids the "memory loss" in long stages.

## VERDICT

```yaml
verdict: MEDIUM
reviewer: gemini
reviewed_at: 2026-06-14T20:15:00Z
commit: 832cad746b4e0944dc05f2922ae289b9d5b89808
critical_count: 0
high_count: 1
medium_count: 3
low_count: 1
```
