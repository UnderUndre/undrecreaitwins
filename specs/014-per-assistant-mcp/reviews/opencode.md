# SpecKit Review: 014-per-assistant-mcp

**Reviewer**: opencode (GLM-5.1)
**Reviewed at**: 2026-06-08T03:15:00+03:00
**Commit**: 1248b4afb7e3b609c91411cc7f29b44af8e320fb
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/mcp-broker.contract.md, contracts/mcp-catalog-api.contract.md, research.md, quickstart.md, checklists/requirements.md

## Summary

Architecturally solid — the broker-through-gateway model is the right call and preserves 010's security invariant. The spec is unusually well-grounded in the existing codebase (hermes-executor.ts:266, 011 KMS/SSRF reuse). The two weaknesses: (1) the SSRF "pin" semantics at connect-time are assumed from 011 but not explicitly stated, leaving a DNS-rebinding window if the implementation re-resolves the hostname; (2) the `isWrite:false` default for un-annotated external tools creates a double-execution risk on retry — `requiresConfirmation:true` mitigates UX but not data integrity. Both are fixable without re-architecting.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Security (SSRF) | FR-005 requires SSRF at both registration and connect. The spec says "reuse 011 DNS-resolve-and-pin" but never explicitly states that the **resolved IP is pinned and used for the actual HTTP connection** (not re-resolving the hostname). If `mcp-client.ts` at connect-time does `fetch(hostname)` instead of `fetch(pinnedIp)`, DNS rebinding bypasses the SSRF defense — the registration check saw a public IP, the connect call hits `127.0.0.1`. This is the #1 threat surface the spec exists to prevent. | Add to FR-005 (or mcp-broker.contract.md) an explicit invariant: "The engine MUST pin the IP resolved at registration and connect to that IP (not the hostname) for all subsequent HTTP calls to the entry." Confirm the 011 dispatcher implementation does this; add a test case for DNS rebinding. |
| F2 | HIGH | Data integrity | research.md §c + data-model.md: un-annotated external tools default to `isWriteAction:false`, meaning no reserve→execute→finalize idempotency. If the tool actually mutates state and the agent retries (network timeout, partial failure), it double-executes. `requiresConfirmation:true` only gates whether the agent *asks the user* before calling — it does NOT prevent double-execution on retry. A mutating-but-unannotated tool (e.g., a payment API or resource-creation endpoint) could create duplicate resources. | Default un-annotated tools to `isWriteAction:true` (full write-treatment on until proven safe), OR require explicit classification before a tool becomes callable (block un-classified tools from the agent's toolset). The first option is safer; the second is more admin-friendly but risks tools being silently unavailable. |
| F3 | MEDIUM | Atomicity (WRAP) | tasks.md T010 bundles edits to three files (`mcp-server.ts` + `tool-gateway.ts` + `hermes-executor.ts`) AND the heaviest implementation piece (external write-treatment through reserve→execute→finalize). Constitution WRAP: <500 LOC, one concern per PR. This task risks exceeding both. | Split T010: T010a = inject brokered tool definitions into gateway (mcp-server + hermes-executor session-build wiring); T010b = external write-treatment in tool-gateway (the CQ3 machinery). The analyze review (F2) flagged this — reinforcing. |
| F4 | MEDIUM | Consistency | tasks.md Dependency Graph: T010 has no incoming edge. The Parallel Lanes show `T008 → T009 → T010` but the formal Dependencies section doesn't list `T009 → T010`. A scheduler reading only the Dependencies section could start T010 before T009 (the broker that produces the ToolDefinitions T010 wires). The mermaid graph also omits this edge. | Add `T009 → T010` to the Dependencies section and the mermaid graph. |
| F5 | MEDIUM | Security (isolation) | `assistant_mcp_binding` has `tenant_id` + `catalog_entry_id` FKs but no DB-level constraint that both share the same tenant. RLS on the API layer protects reads, but a bug in the write path could insert a cross-tenant binding (persona from tenant A → entry from tenant B). RLS would hide the result from both tenants, creating an orphan binding that still gets resolved at session build if the broker queries by `persona_id` without re-checking tenant match. | Add a DB CHECK constraint or a composite FK ensuring `binding.tenant_id = entry.tenant_id`. Alternatively, the broker's query must JOIN on tenant_id (not just trust RLS). |
| F6 | MEDIUM | Performance | Session build discovers tools for each bound entry. If the cache is cold for N entries, that's N sequential HTTP calls (initialize + tools/list per server) before the turn starts. For a persona bound to 5 MCP servers, this could add 5× connect latency to every first turn. | Specify parallel discovery: all entry connections initiated concurrently, bounded by a concurrency limit. Failures are independent (already specified as degrade). |
| F7 | MEDIUM | Ambiguity | "Vetted" is used throughout the spec (spec.md:2, :28, :87, :92) but never defined. What makes a server "vetted"? The registration API (FR-001) accepts any HTTP URL with SSRF validation — there's no review/approval workflow, no checklist, no human gate. "Vetted" implies a security review that the spec doesn't actually require. | Either (a) replace "vetted" with "registered" (accurate to what FR-001 does), or (b) define a vetting process (admin marks entry as reviewed, tools not surfaced until reviewed). Option (a) is honest; option (b) is safer. |
| F8 | LOW | Edge case | Tool schema can drift between cached discovery (tools/list) and actual call. A server updates its tools between the TTL cache fill and a `tools/call` — the agent calls with stale parameters, gets an error. Not a security issue but a user-experience gap. | Consider a staleness warning in the error path: if `tools/call` returns "tool not found" or "invalid params", invalidate the cache for that entry so the next turn gets fresh discovery. |
| F9 | LOW | Edge case | `rescan` endpoint (POST /catalog/:id/rescan) invalidates cache, but what if a turn is actively using the cached tool list? Race condition between concurrent rescan + turn execution. | Document expected behavior: rescan invalidates cache but doesn't interrupt in-flight turns. The next turn picks up the fresh tool list. |
| F10 | LOW | Underspecification | Tool include/exclude syntax is not specified. Glob pattern? Exact match? Regex? Admins need to know what to type. | Pick one (exact match is simplest and safest for v1), document in mcp-catalog-api.contract.md. |
| F11 | LOW | Security (DoS) | No maximum payload size specified for external MCP responses. A malicious server could return a `tools/list` with thousands of entries or multi-MB parameter schemas, exhausting broker memory during discovery. | Add a max-response-size limit in `mcp-client.ts` (e.g., 1MB per response). Discovery should reject oversized responses and mark the entry as degraded. |

## Alternative approaches considered

1. **Sidecar proxy model**: instead of brokering in-process within the engine, run a per-tenant sidecar that applies SSRF/audit/permission controls. Pro: decouples broker lifecycle from engine sessions, allows independent scaling and pre-warming. Con: adds infra complexity, another hop, harder to guarantee "gateway = sole authority" when the proxy is separate. Worth noting for v2 if in-process broker becomes a bottleneck.

2. **Block-unclassified model for tool safety**: instead of defaulting un-annotated tools to `isWrite:false` with `requiresConfirmation:true`, require explicit admin classification before a tool is surfaced at all. Pro: eliminates the double-execution risk (F2). Con: more admin friction, tools silently unavailable until classified. Weigh against the F2 recommendation.

3. **Streaming MCP transport**: the hand-rolled client only handles request-response JSON-RPC over HTTP. MCP protocol supports SSE/streamable HTTP transport. If the external MCP ecosystem moves toward streaming, the client will need an upgrade path. Not blocking for v1, but the client's interface should not make this impossible.

## VERDICT

```yaml
verdict: HIGH
reviewer: opencode
reviewed_at: 2026-06-08T03:15:00+03:00
commit: 1248b4afb7e3b609c91411cc7f29b44af8e320fb
critical_count: 0
high_count: 2
medium_count: 5
low_count: 4
note: "Two HIGH findings — SSRF pin semantics and un-annotated tool double-execution risk — are fixable without re-architecting. The broker-through-gateway design is sound. Recommend resolving F1+F2 before implement."
```
