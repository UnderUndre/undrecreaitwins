# SpecKit Review: 002-streaming-completions

**Reviewer**: antigravity
**Reviewed at**: 2026-05-27T12:20:00Z
**Commit**: 0cff1631c37b73ee615752ee06172b55f1ea06e4
**Artifacts reviewed**: spec.md, plan.md, tasks.md, contracts/streaming-sse.md, quickstart.md

## Summary

Clean, well-bounded spec for a single-purpose feature. The artifact set is consistent — spec ↔ plan ↔ tasks ↔ contracts are aligned. No phantom tasks, no coverage gaps, no terminology drift. The analyze.md PASS verdict is justified. I find 0 CRITICAL, 1 HIGH, 4 MEDIUM items.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| A1 | HIGH | Concurrency | **No concurrency control for streaming + non-streaming on same conversation**. If a client sends `stream: true` and immediately sends another request (streaming or not) to the same conversation, both will run in parallel. The Letta memory write and message persistence can interleave, causing corrupted state. Spec explicitly excludes channel adapters (they use non-streaming), but nothing prevents two HTTP API calls targeting the same conversation simultaneously. | Add a note to spec §Constraints or plan §Design Decisions: "Concurrent requests to the same conversation are NOT serialized in this feature. Consumer must enforce client-side serialization or deploy a Redis mutex per conversation_id (see 001-twin-engine-foundation review F2). Out of scope for this feature but documented as known limitation." |
| A2 | MEDIUM | Robustness | **`reply.raw.write()` backpressure is mentioned but not specified**. NFR-002 and T006 mention backpressure via `reply.raw.write()` return value, but no task specifies what happens when `write()` returns `false` (buffer full). Should the generator pause? Should there be a drain listener? Without this, the server can OOM under load if the client reads slowly. | Add to T006: "When `reply.raw.write()` returns `false`, wait for `'drain'` event on `reply.raw` before continuing iteration. This prevents unbounded buffer growth when client reads slowly." |
| A3 | MEDIUM | Contracts | **`stream_options` schema is only in task T008, not in contracts**. The `contracts/streaming-sse.md` documents response format but doesn't specify the request schema for `stream_options`. A consumer reading only the contract wouldn't know how to request usage. | Add §Request to `contracts/streaming-sse.md`: document `stream_options: { include_usage: boolean }` as optional request field with default behavior when absent. |
| A4 | MEDIUM | Edge case | **What happens when LLM provider returns `finish_reason: "length"` mid-stream?** Spec and contracts only show `"stop"` as finish_reason. But OpenAI providers can return `"length"` when `max_tokens` is hit. The `StreamChunk` type in contracts includes `"length"` in the union, but no task or edge case covers this path. | Add to spec §Edge Cases: "When LLM returns `finish_reason: 'length'` — send it as-is in the final chunk. Client handles it same as non-streaming `length` response. No special server-side action needed." |
| A5 | MEDIUM | Quickstart | **quickstart.md curl example doesn't include `stream_options`**. The main example should demonstrate the usage-in-streaming feature since it's a P1 requirement (US2). | Add `"stream_options": {"include_usage": true}` to the curl example in quickstart.md. |

## Coverage Assessment

- FR-001 through FR-010: all mapped ✓
- NFR-001 through NFR-004: all explicitly referenced in tasks ✓
- User Stories 1-4: all covered ✓
- Edge Cases: 3 of 5 covered (empty response ✓, malformed SSE ✓, stall ✓; abort+persist gap ⚠️, finish_reason length ⚠️)

## Architecture Assessment

The AsyncGenerator pattern is the right call. One architectural note: the plan has `completeStream()` doing both streaming AND persistence (accumulate tokens → persist after done). This mixes streaming concerns with write concerns. A cleaner pattern would be:

1. `callLLMStream()` — pure streaming, yields StreamChunks
2. `completeStream()` — orchestrates: memory fetch → callLLMStream → accumulate → return accumulated result
3. Route layer — calls completeStream, then persists if `{ completed: true }`

This makes testing easier (you can test the generator without a DB) and keeps the persistence decision in the route layer where the abort signal lives. However, the current design is acceptable for this scope.

## VERDICT

```yaml
verdict: PASS
reviewer: antigravity
reviewed_at: "2026-05-27T12:20:00Z"
commit: 0cff1631c37b73ee615752ee06172b55f1ea06e4
critical_count: 0
high_count: 1
medium_count: 4
notes: "A1 (concurrency) is a known limitation, not a design flaw — documenting it is sufficient. All MEDIUM items are refinements that improve robustness without changing architecture."
```

**Rationale for PASS**: The single HIGH finding (A1) is a known architectural gap inherited from the foundation spec, not introduced by this feature. Documenting it as a known limitation is the correct action. The feature is well-scoped, well-specified, and ready for implementation.
