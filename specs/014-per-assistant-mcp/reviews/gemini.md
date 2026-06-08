# SpecKit Review: 014-per-assistant-mcp

**Reviewer**: gemini
**Reviewed at**: 2026-06-08T12:00:00Z
**Commit**: 1248b4afb7e3b609c91411cc7f29b44af8e320fb
**Artifacts reviewed**: spec.md, plan.md, tasks.md, .specify/memory/constitution.md

## Summary

The design successfully meets the core security requirement of maintaining the engine's MCP gateway as the sole authority, properly isolating external tools via a broker pattern. However, there are significant gaps in how the system handles the physical limits of external integrations, specifically regarding distributed idempotency guarantees, LLM tool name constraints, and unbounded response payloads.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Architecture | **False Idempotency on External Writes**: FR-011 and T010 require applying the engine's native `reserve->execute->finalize` workflow to external tools. However, wrapping a black-box HTTP call in the engine's local state machine does NOT make the external mutation idempotent. If the connection drops during `execute`, the engine won't finalize, but the external state may have mutated. The engine cannot guarantee idempotency for systems it doesn't control. | Clarify in `spec.md` that external write idempotency is best-effort. Add a requirement to document to tenant-admins that their external write tools must handle retries safely. Do not treat external writes as perfectly safe just because they are wrapped in the engine's transaction phases. |
| F2 | HIGH | Edge case | **LLM Tool Name Constraint Violations**: T006 and T009 specify namespacing tools as `mcp_<entry>_<tool>`. LLM providers (like OpenAI) have strict constraints on tool names (e.g., max 64 chars, regex `^[a-zA-Z0-9_-]+$`). A long `entry` name combined with a long `tool` name will result in 400 Bad Request from the LLM provider, breaking the turn. | Enforce strict regex validation and max length (e.g., 16 chars) on `mcp_catalog_entry.name` at creation (T004). Ensure the synthesized `mcp_<entry>_<tool>` name never exceeds LLM limits. |
| F3 | MEDIUM | Performance | **Sequential Discovery Latency**: If an assistant binds multiple external MCP servers, the cache-miss discovery path (T009) could block the turn start significantly if calls are made sequentially. | Explicitly require `Promise.allSettled()` (parallel execution) in `mcp-broker.ts` when resolving multiple bindings during a cache miss. |
| F4 | MEDIUM | Security | **OOM via Unbounded Payloads**: The hand-rolled minimal MCP client (T008) mentions `timeout_ms` but no payload size limits. An external server returning a 100MB JSON payload for `tools/list` or `tools/call` will cause V8 OOM crashes. | Add a strict `max_body_size` limit (e.g., 1MB-5MB) to the hand-rolled MCP client's `undici` requests, aborting the stream if exceeded. |

## Alternative approaches considered

**Schema Persistence vs. Runtime Discovery Cache**: Instead of a runtime TTL cache for tool discovery (FR-013), the engine could fetch the schema at configuration time (via the admin UI / API) and persist the `ToolDefinition`s into the Postgres database. This would eliminate discovery latency from the turn critical path entirely, though it introduces the trade-off of needing a manual "resync" button if the external server updates its tools. Given the realtime nature of MCP, the TTL cache is fine, but the DB persistence model provides better strict latency guarantees.

## VERDICT

```yaml
verdict: HIGH
reviewer: gemini
reviewed_at: 2026-06-08T12:00:00Z
commit: 1248b4afb7e3b609c91411cc7f29b44af8e320fb
critical_count: 0
high_count: 2
medium_count: 2
low_count: 0
```