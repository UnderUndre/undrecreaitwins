# SpecKit Analyze: 018-response-quality-rules

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-14T14:30:00Z
**Commit**: d46e4fbe507d38d79b9ae6daa8d3ab90d9952d98
**Artifacts**: spec.md, plan.md, tasks.md, data-model.md, contracts/dar-pipeline-contract.md

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Inconsistency | HIGH | spec.md:110 (FR-007) vs tasks.md T012 + plan.md §Stream1.7 + contracts §4 | **Re-validation approach conflicts.** FR-007 says call `validatorPipeline.validateResponse(rewrittenText, { darRevalidation: true })` (reuse the shared singleton with a flag). Tasks T012, plan, and contract all say "instantiate `FalsePromiseValidator(llm)` + `IdentityGuardValidator()` directly." The `darRevalidation` flag does NOT exist in the 004 `ValidatorPipeline` code (`pipeline.ts:30` accepts `{ tenantId, personaId, conversationId, messageId?, rawUserMessage? }`). Worse: `validateResponse()` can MUTATE text (identity-guard rewrites to fallback, false-promise appends disclaimer) — for re-validation we want DETECTION only, not mutation. | Update spec FR-007 to match plan/tasks: "Instantiate 004 validators directly (`new FalsePromiseValidator(llm)`, `new IdentityGuardValidator()`), call `validateAndMutate()`, check result WITHOUT applying mutations. 1 pass." Delete the fictional `darRevalidation` flag reference. |
| F2 | Coverage Gap | MEDIUM | spec.md:142 (edge case) vs tasks.md (no task) | **Conversation-level rubric edge case unhandled.** Spec edge case: "Conversation-level rubric rule (turnScope=conversation) → engine ignores the turnScope field, treats as single-message. Log a warning." No task implements this defensive check + warning log. | Add a defensive check in DAR pipeline T013: if `rule.turnScope === 'conversation'`, log warning `"turnScope=conversation not yet supported, treating as single-message"` and proceed as single. Small addition, no new task needed. |
| F3 | Coverage Gap | MEDIUM | contracts §1 vs ai-twins 019 Product spec | **Cross-repo conditional GET contract gap.** Engine 018 contract defines `If-None-Match` / `304 Not Modified` conditional GET support expected from Product `GET /v1/correction-rules`. The Product spec (ai-twins 019) defines the endpoint but does NOT mention conditional GET, ETags, or 304 responses. Product side needs to implement ETag generation + conditional response. | Coordinate cross-repo: Product (ai-twins 019) must add ETag/304 support to `GET /v1/correction-rules` response. Not a blocker for Engine plan (Engine degrades gracefully — pull always works without conditional GET), but Product must implement it for the cache-efficiency benefit. |
| F4 | Constitution | MEDIUM | constitution Principle VII | **Earlier pipeline stages unversioned.** Only `plan/018-response-quality-rules/v1` and `tasks/018-response-quality-rules/v1` git tags exist. No `specify/018-...` or `clarify/018-...` tags. The spec was pre-existing (not created via `/speckit.specify` in a tagged session). Principle VII requires every stage that mutates artifacts to tag. | Retroactively tag the spec at its creation commit, or accept the gap (spec was created outside the pipeline). Not blocking — the plan+tasks are properly versioned. |

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| FR-001 rule-pull-client | ✅ | T002 | Product API client with conditional GET |
| FR-002 rule-cache-webhook | ✅ | T003, T005 | TTL cache + webhook invalidation |
| FR-003 dar-pipeline-executor | ✅ | T008, T013 | Score-only → full pipeline |
| FR-004 detector-impls | ✅ | T006, T009 | Regex/keyword + pattern/semantic |
| FR-005 detector-aggregation | ✅ | T007 | Priority sort + cap ≤4 |
| FR-006 rewrite-execution | ✅ | T011 | Single LLM pass |
| FR-007 re-validation | ✅ | T012 | **See F1 — approach inconsistency** |
| FR-008 rollback | ✅ | T013 | Fan-out events |
| FR-009 event-push-client | ✅ | T004 | Fire-and-forget |
| FR-010 chat-service-integration | ✅ | T015 | Post-validateResponse hook |
| FR-011 scope-full-only | ✅ | (implicit) | No splitting needed — full is default |
| FR-012 turnscope-single-only | ✅ | (implicit) | **See F2 — conversation edge case unhandled** |
| FR-013 latency-budget | ✅ | T009, T013 | Concurrency cap + overflow skip |
| FR-014 error-handling | ✅ | T013, T004 | Fail-open wrapper |
| FR-015 score-mode-async | ✅ | T010, T013 | setImmediate |
| NFR-1 isolation | ✅ | T002, T005 | X-Tenant-ID + webhook secret |
| NFR-2 perf-2s | ✅ | T009, T013 | Parallelize + latency tracking |
| NFR-3 reliability | ✅ | T013, T004 | Fail-open everywhere |
| NFR-4 cost-budget | ⚠️ | T009, T013 | Soft-defaults implemented; per-tenant budget = 010 OpenMeter (not this layer) |
| NFR-5 testability | ✅ | T017, T018 | Unit + integration |
| NFR-6 observability | ✅ | T015 | Langfuse trace + pino |

## Constitution Alignment Issues

- **Principle VII (Artifact Versioning)**: Earlier stages (specify/clarify) not versioned. See F4. Not blocking — plan+tasks properly tagged.
- **Principle VI (Cross-AI Review)**: Analyze is the first gate. External reviews pending after this passes. On track.

## Unmapped Tasks

All 18 tasks map to at least one FR or NFR. No orphan tasks.

## Metrics

- Total Requirements: 21 (15 FR + 6 NFR)
- Total Tasks: 18
- Coverage % (requirements with ≥1 task): 100% (21/21; NFR-4 partially — soft defaults covered, hard budget deferred to 010)
- Ambiguity count: 0
- Duplication count: 0
- CRITICAL count: 0
- HIGH count: 1
- MEDIUM count: 3
- LOW count: 0

## VERDICT

```yaml
verdict: MEDIUM
reviewer: analyze
reviewed_at: "2026-06-14T14:30:00Z"
commit: d46e4fbe507d38d79b9ae6daa8d3ab90d9952d98
critical_count: 0
high_count: 1
medium_count: 3
low_count: 0
note: "F1 (re-validation approach conflict spec vs tasks) should be resolved before external review — update spec FR-007 to match the plan/tasks approach. F2/F3 are minor gaps that can be addressed during implementation. No blockers for proceeding to external review."
```
