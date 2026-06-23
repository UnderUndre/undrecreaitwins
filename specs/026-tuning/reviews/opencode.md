# SpecKit Review: 026-tuning

**Reviewer**: opencode
**Reviewed at**: 2026-06-23T00:00:00Z
**Commit**: HEAD
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/tuning-api.md, research.md, quickstart.md

## Summary

Solid spec-to-tasks pipeline: clear user stories, good reuse map, thorough clarifications, complete data-model with drizzle schema. Plan follows established engine monorepo patterns. Tasks have proper dependency graph and phase boundaries. Main concerns: LLM token budget for extraction is unaddressed, ChatService overlay mechanism needs explicit spec, and in-process generation needs startup cleanup for crash recovery.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Hidden assumption / Performance | **LLM token budget for doc extraction is unaddressed.** T008 says "reads RAG chunks for persona, calls LLM". The `document_chunks` table can contain hundreds of chunks per persona. Feeding all chunks into a single LLM call will exceed context windows and/or be prohibitively expensive. SC-001 targets "≤5 documents, ≤50KB total" but T008/research.md don't specify chunk selection/truncation strategy for larger sets. | Specify chunk selection strategy in T008: e.g., (a) top-K chunks by relevance (cosine sim with "business description" query), (b) concatenate with max token budget (e.g., 8K tokens), (c) truncate/summarize for large doc sets. This is a practical implementation constraint that will block T008 if not resolved upfront. |
| F2 | HIGH | Hidden assumption / Architecture | **SandboxDraftMode coupling is under-specified.** T018 says "Patch `ChatService.buildSystemPrompt()` to inject draft overlay". `ChatService.complete()` (`chat-service.ts:168`) loads persona from DB at line 174, then uses it across funnel runtime (line 267), validator pipeline, and LLM system prompt. The plan doesn't specify: does the overlay replace the persona object? Does it patch individual fields? Does it flow into funnel + validators or only the system prompt? data-model.md §4 defines `DraftConfigOverlay` but doesn't specify propagation to sub-pipelines. | Explicitly specify in T018: which ChatService internals receive the overlay (system prompt builder, funnel runtime, validator pipeline). Recommended: add `draftOverride?: DraftConfigOverlay` to `ChatRequest` type; ChatService checks override fields after DB load and replaces corresponding persona fields before passing to sub-pipelines. |
| F3 | HIGH | Failure modes | **In-process background task (FR-002) has no crash recovery on process restart.** T009 uses `process.nextTick(() => runGenerationPipeline(...))`. If the Fastify process restarts (crash, deploy, OOM), ALL in-flight generations are lost. T030 implements a poll-time reaper (90s timeout), but if nobody polls the draft (Product gives up after 120s per NFR-3), it stays `generating` forever. | Add a startup cleanup task to T007 (route scaffolding / server init): on Fastify ready, scan for `status=generating` drafts older than 5 minutes and flip to `failed` (`error: 'GENERATION_STALLED'`). Document reaper + startup hook as paired recovery mechanism. |
| F4 | MEDIUM | Logical consistency | **FR-011 (concurrent lock) enforcement mechanism is unclear.** T004 says "throw on second generating draft for same persona" but T009 fires generation as `process.nextTick` — if two concurrent HTTP requests hit `generate` simultaneously, the check-then-insert pattern is a TOCTOU race: both check "no generating draft", both insert, both start background tasks. T026 covers this as an edge case but uses "DB-level check" without specifying unique constraint. | Specify enforcement: either (a) DB partial unique index `CREATE UNIQUE INDEX ... ON tuning_drafts (tenant_id, persona_id) WHERE status = 'generating'` + catch unique violation → 409, or (b) use `INSERT ... ON CONFLICT DO NOTHING` with the partial index. Option (a) is simplest and race-free. |
| F5 | MEDIUM | Edge cases | **Interview adaptive skip (T020: "skip questions already covered by docs")** mechanism is unspecified. research.md §3.2 mentions it but doesn't define HOW: embedding cosine similarity? LLM classification? Keyword matching? Threshold? Without a concrete mechanism, T020 is ambiguous. | Either: (a) defer adaptive skip to v1.1 (always ask all 7 questions for v1), or (b) specify mechanism in T020: e.g., "for each question, check if persona has document chunks with cosine sim > 0.85 to the question embedding; if yes, auto-answer from doc content and skip." |
| F6 | MEDIUM | Failure modes | **LLM rate limiting / transient errors during extraction have no retry.** T008 catches errors → draft `failed`. T024 handles timeout. But a single transient LLM 429/5xx (common with OpenAI) wastes the entire extraction attempt. The codebase already has `ProviderRetryWorker` (`retry/provider-retry.worker.ts`). | Add simple retry with backoff (2 retries, 1s/3s delay) for LLM calls in T008. Log retry attempts. Matches existing retry patterns in the codebase. |
| F7 | MEDIUM | Security | **Sandbox preview (T019) may bypass tenant-scoped validator enforcement.** If the draft overlay (T018) patches the persona object but doesn't propagate `validatorToggles` to `ValidatorPipeline.validateInput()`, the pipeline runs with LIVE validator config — a draft that disables a validator wouldn't be reflected in the sandbox preview. | Ensure T018's overlay explicitly passes `validatorToggles` from the draft to the validator pipeline, not just systemPrompt + funnelConfig. |
| F8 | LOW | Stakeholder clarity | **"Confidence" thresholds are partially defined.** FR-013 says "block-rate >30% = low" but doesn't define medium vs high. Product UI shows green/amber/red badges. data-model.md §5 references `confidence: 'high' | 'medium' | 'low'` in ExtractionOutput but no thresholds. | Define in research.md or spec: `low` = block-rate >30% OR partial JSON. `medium` = block-rate 15-30%. `high` = block-rate <15% AND full structured JSON. |
| F9 | LOW | Logical consistency | **Contract `tuning-api.md` omits error responses.** Happy-path-only contract. FR-003 mentions reaper → `failed`, FR-007 mentions `NO_PREVIOUS_SNAPSHOT` → 400, FR-011 mentions `CONFLICT_DRAFT_ACTIVE` → 409. Contract should list these per endpoint for Product team. | Add `{ status, error_code, when }` table per endpoint in `contracts/tuning-api.md`. |
| F10 | LOW | Alternative approaches | **T009 fire-and-forget vs BullMQ.** The codebase already uses BullMQ for training jobs (`packages/training/`) and retry workers. Using BullMQ for tuning generation would give automatic retries, crash recovery, and job visibility — addressing F3. The spec explicitly chose in-process for simplicity. This is defensible for v1, but plan.md should note the trade-off and migration path. | Add note to plan.md §Complexity Tracking: "In-process generation chosen over BullMQ for v1 simplicity. Migration path: replace `process.nextTick` with `tuningQueue.add()` when scaling beyond single-instance. Startup cleanup (F3) covers the gap." |

## Alternative approaches considered

1. **Durable job queue (BullMQ) instead of in-process fire-and-forget**: Existing infrastructure (`ProviderRetryWorker`, training queue) supports it. Would solve F3 automatically. Trade-off: adds Redis queue dependency to the generation path (currently Redis is only for ephemeral interview/proposal state). Defensible to defer to v1.1 if startup cleanup (F3) is implemented.

2. **Separate `tuning_proposals` DB table instead of Redis cache**: Persistent table with `status: active/dismissed/accepted` would give audit trail and eliminate `PROPOSAL_EXPIRED`. Trade-off: another table + cleanup job. Redis TTL is fine for v1.

3. **Draft version chain (`previousDraftId` FK) instead of `previousSnapshot` JSONB**: Linked list of drafts for rollback instead of snapshot. Pros: no JSONB size growth, structural integrity. Cons: more complex queries. Current approach is simpler for v1.

## VERDICT

```yaml
verdict: MEDIUM
reviewer: opencode
reviewed_at: 2026-06-23T00:00:00Z
commit: HEAD
critical_count: 0
high_count: 3
medium_count: 4
low_count: 3
```
