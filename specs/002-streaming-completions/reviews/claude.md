# SpecKit Review: 002-streaming-completions

**Reviewer**: claude
**Reviewed at**: 2026-05-27T12:15:00Z
**Commit**: 0cff1631c37b73ee615752ee06172b55f1ea06e4
**Artifacts reviewed**: spec.md, plan.md, tasks.md, contracts/streaming-sse.md, quickstart.md

## Summary

Well-scoped, tight feature spec. Single responsibility: replace fake streaming with real token-by-token SSE. The plan makes correct architectural choices (AsyncGenerator, AbortController at route layer, accumulate-then-persist). Analyze.md verdict PASS is fair — the artifacts are internally consistent with 100% coverage. My review finds 0 CRITICAL, 2 HIGH, 3 MEDIUM items that should be addressed before implementation.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| C1 | HIGH | Error handling gap | **Partial usage on abort is underspecified**. Spec says "partial usage is NOT written" (US3 scenario 2), but T004 persists usage "after generator completes". If the generator is aborted mid-stream, `completeStream()` must distinguish between normal completion and abort to skip the persist step. Currently T005 says "on abort: stop yielding, skip persistence" but this is in the generator — the caller (`handleStream`) must also know not to persist. | Add an explicit return type for `completeStream()` that includes a `{ completed: boolean }` flag. The route layer checks this flag before calling persist. Matches the existing AI-Generated Code Guardrail in CLAUDE.md: "Caller ignoring `{ committed: boolean }` flag". |
| C2 | HIGH | Contracts | **No `Content-Type` header specification for error SSE events**. `contracts/streaming-sse.md` defines error event payloads but doesn't specify whether the response headers are already sent (SSE mode) or if an early error (before headers) should return a normal JSON error. The `handleStream` rewrite in T006 must handle both cases. | Add to contracts/streaming-sse.md §Error handling: "If error occurs before `writeHead(200)` → return normal JSON `{error: {...}}` with appropriate HTTP status. If error occurs mid-stream → send SSE error event, then `reply.raw.end()`." Plan.md DD-004 should reference this. |
| C3 | MEDIUM | Testing | **No integration test task for streaming**. T009 verifies non-streaming regression and T010 is a manual curl test, but there is no automated test that spins up Fastify, sends a streaming request, and asserts incremental SSE chunks. For a feature whose core value is sub-second latency, manual testing is insufficient. | Add T013 `[E2E]` — integration test: mock LLM provider returning SSE, assert ≥3 chunks received before `[DONE]`, assert usage in final chunk, assert abort cleans up. Depends on T008. |
| C4 | MEDIUM | Edge case coverage | **Empty response from LLM (0 tokens) edge case has no task**. Spec mentions it: "Send role chunk + finish_reason: stop + usage with completion_tokens: 0." But no task explicitly covers this path. T003 (parser) and T006 (route) should handle it, but it's easy to miss in implementation. | Add explicit edge case test scenario to T010 or T013: "stream request where LLM returns 0 tokens → verify graceful completion, not hang." |
| C5 | MEDIUM | Plan accuracy | **plan.md §Files to Modify lists `chat-service.ts` twice** with different descriptions. Minor but confusing — implies two separate changes when it's one file with two new methods. | Consolidate into single row: "Add `completeStream()` + `callLLMStream()`, extract usage + persist after stream completion." |

## Coverage Assessment

- All 10 FR requirements mapped to tasks ✓
- All 4 NFR requirements explicitly referenced in tasks ✓
- 4 user stories covered ✓
- Edge cases partially covered (empty response has no task) — MEDIUM

## Architecture Review

The AsyncGenerator + AbortController pattern is sound. Key strength: `completeStream()` yields parsed objects (DD-001), keeping the service layer transport-agnostic. The route layer owns HTTP lifecycle concerns (SSE formatting, writeHead, client disconnect detection). Clean separation.

One concern: the generator accumulates content internally (DD-002) for persistence. This means the generator has dual responsibility (stream + accumulate). Consider returning the accumulated content as the generator's return value (using `return` in an async generator), so the caller can decide whether to persist.

## VERDICT

```yaml
verdict: PASS
reviewer: claude
reviewed_at: "2026-05-27T12:15:00Z"
commit: 0cff1631c37b73ee615752ee06172b55f1ea06e4
critical_count: 0
high_count: 2
medium_count: 3
notes: "HIGH findings are design gaps, not blockers. Can be resolved during implementation if tasks are annotated. Recommend addressing C1 before T004/T005 implementation."
```

**Rationale for PASS despite 2 HIGH**: Both HIGH items (C1, C2) are specification precision issues that don't block implementation — they're the kind of thing a competent implementer would encounter and resolve correctly. But documenting them upfront prevents ambiguity during implementation.
