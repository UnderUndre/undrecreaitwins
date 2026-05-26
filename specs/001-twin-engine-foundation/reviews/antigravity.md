# SpecKit Review: 001-twin-engine-foundation

**Reviewer**: antigravity
**Reviewed at**: 2026-05-26T05:45:00Z
**Commit**: 621eb6fe6d07f2ce0e579b297ec9810b2926efa5
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, quickstart.md, research.md

## Summary

The team has successfully addressed the critical RLS connection pooling leakage and updated the Qdrant architecture to a single-collection payload-filtered model. However, several high-severity concurrency and architecture issues remain unaddressed from the previous review. Additionally, a new gap was introduced where the newly specified API token authentication is entirely missing from the implementation tasks.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Logical Consistency | **API Token Auth Missing from Middleware**. Spec FR-031c requires Standalone deployments to support API token auth via `Authorization: Bearer <token>`, validating against the `api_tokens` table. T009b adds the table, but T011 (Tenant Middleware) still only checks `X-Tenant-ID` and JWT, completely ignoring the API token path. | Update T011 to extract the Bearer token, hash it, look it up in the `api_tokens` table via a fast cached read, and set the tenant context accordingly if valid. |
| F2 | HIGH | Concurrency | **No Conversation Locking** *(Repeat Finding)*. If a user sends multiple messages rapidly, the adapter publishes them instantly. The orchestrator (T038) will trigger parallel LLM requests via OmniRoute. This leads to Letta state corruption and duplicate/out-of-order replies. | Add a Redis-backed mutex (e.g., Redlock) per `conversation_id` in `chat-service.ts` (T020) to ensure only one LLM completion runs per conversation at a time. |
| F3 | HIGH | Edge Case | **In-Memory LRU Cache for Idempotency** *(Repeat Finding)*. T038 specifies an in-memory LRU cache to deduplicate inbound messages. If `twin-engine-api` is horizontally scaled, the cache is not shared, meaning duplicate webhooks or pub/sub fan-out could trigger multiple completions. | Update T038 to use Redis `SETNX` with an expiration (e.g., 5 mins) using the `(channel_id, channel_message_id)` tuple for distributed idempotency instead of an in-memory LRU cache. |
| F4 | MEDIUM | Logical Consistency | **Stale RAG Collection Naming Task**. Spec FR-023 and the research doc were updated to use a single shared Qdrant collection with payload filtering. However, T004 in `tasks.md` still dictates creating a "RAG collection naming convention function" which contradicts the single-collection strategy. | Remove the collection naming convention function from T004 and replace it with a constant for the shared collection name (e.g., `twin_engine_rag`). |
| F5 | MEDIUM | Architecture | **Letta Fallback Recovery** *(Repeat Finding)*. The spec mentions falling back to in-context memory if Letta is unreachable. However, the `messages` table acts as a source of truth that Letta might miss during its downtime. | Clarify in T020 if/how Letta agents are resynced from the `messages` DB upon recovery, otherwise the memory state permanently diverges. |
| F6 | MEDIUM | Security | **Webhook Authentication** *(Repeat Finding)*. The channel adapter specs do not explicitly mandate validating incoming webhook signatures. | Add explicit requirements to validate incoming webhook signatures in T039 (Telegram secret token) and T042 (Evolution API) to prevent request spoofing. |

## Alternative approaches considered

- **AsyncLocalStorage for DB Transactions**: (Acknowledged and resolved in T010).

## VERDICT

```yaml
verdict: HIGH
reviewer: antigravity
reviewed_at: 2026-05-26T05:45:00Z
commit: 621eb6fe6d07f2ce0e579b297ec9810b2926efa5
critical_count: 0
high_count: 3
medium_count: 3
low_count: 0
```
