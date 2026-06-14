# SpecKit Analyze: 019-feedback-loop-closure

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-14T19:40:00Z
**Commit**: 4cb53d89fc4e78045680316d0caf642ee6c650b5
**Artifacts**: spec.md, plan.md, tasks.md, data-model.md, contracts/feedback-loop-contract.md

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Inconsistency | MEDIUM | spec.md:120 ("017... all built, needs wiring") vs plan.md §Summary | **Spec prerequisite claim incorrect.** Spec says feedback_memories "all built, needs wiring" (dependency on 017-hybrid-agent-core). Reality: 017-hybrid-agent-core (in ai-twins repo) defines the table in data-model.md Phase 2 but NEVER implemented it — no migration, no Prisma model, no code. Plan correctly compensates (Phase 0 creates the table). Spec text is stale. | Update spec §Dependencies: change "All built, needs wiring" to "Table designed in 017 Phase 2, not yet implemented. 019 includes table creation." |
| F2 | Inconsistency | MEDIUM | spec.md:87 ("Postgres `conversation_states`") vs plan.md/data-model.md (`conversation_feedback_states`) | **Table name drift.** Spec FR-006 CL Round 2 says "Postgres `conversation_states` table". Plan/data-model creates `conversation_feedback_states` instead. Deliberate (separate from `conversation_funnel_states` which only exists for funnel conversations), but spec text doesn't match implementation name. | Either rename in data-model to `conversation_states` (simpler, matches spec) OR update spec to say `conversation_feedback_states`. Recommend the latter — clearer separation. |
| F3 | Inconsistency | MEDIUM | spec.md:114 (`assistantId`) vs plan.md/data-model.md (`personaId`) | **Cross-repo entity naming.** Spec Key Entities: `FeedbackMemory { ..., assistantId, ... }` (017/Product naming). Engine codebase uses `personas` table + `personaId` column everywhere (annotations, document_chunks). Data-model correctly uses `personaId` for Engine consistency. Spec text carries Product naming into Engine spec. | Update spec Key Entities to note: "`assistantId` (Product naming) = `personaId` (Engine naming) — same entity". Or use `personaId` in the Engine spec since this IS the Engine spec. |
| F4 | Underspecification | MEDIUM | spec.md:82, FR-001 ("similarity × `operator_role` weight × recency decay") | **Recency decay formula undefined.** Spec says scoring = similarity × weight × recency decay, but doesn't specify the decay function (exponential? linear? half-life?). Developer must choose during implementation. | Add to spec or plan: "Recency decay = exponential with 30-day half-life: `decay = exp(-days_since_created / 30)`. Composite score = `cosine_similarity × operator_role_weight × decay`." Or defer to implementation with a reasonable default. |
| F5 | Constitution | LOW | constitution Principle VII | **Earlier pipeline stages unversioned.** Only `plan/` and `tasks/` tags exist. No `specify/` or `clarify/` tags. Same as 018 — spec was created outside the pipeline. | Accepted — not blocking. Plan + tasks properly tagged. |
| F6 | Shared file | LOW | tasks.md Lane 1 (T001 + T002 both modify `index.ts`) | **Parallel `index.ts` modification.** T001 and T002 both add re-exports to `models/index.ts`, with no ordering constraint between them. Same agent ([DB]), same phase — typically sequential in practice. | Add `T001 → T002` ordering or note "T001 before T002 in `index.ts`" to avoid merge conflict if parallelized. |

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| FR-001 feedback-retrieval-service | ✅ | T006 | Embed + cosine search + dedup + weight scoring |
| FR-002 dedup-applied-feedback-ids | ✅ | T008, T009 | Exclude applied IDs, reset per FR-006 |
| FR-003 prompt-composition-service | ✅ | T007 | Budget allocation + layer precedence + conflict directive |
| FR-004 chat-service-integration | ✅ | T008 | Insert at buildSystemPrompt line 946 |
| FR-005 langfuse-trace | ✅ | T010 | feedback_memories_retrieved span |
| FR-006 conversation-state-tracking | ✅ | T008, T009 | conversation_feedback_states table + dedup reset |
| FR-007 per-persona-config | ✅ | T003 | feedbackRetrievalEnabled + feedbackTokenBudget columns |
| FR-008 error-handling-graceful-degradation | ✅ | T006, T008 | TEI/DB failure → empty array, no throw |
| FR-009 empty-set-noop | ✅ | T006 | Check active memories before embedding call |
| FR-010 observability-endpoint | ✅ | T011 | GET /v1/internal/retrieved-feedback |
| NFR-1 latency-50ms | ✅ | T006, T007 | Embed ~10ms + HNSW ~20ms + compose ~5ms |
| NFR-2 isolation-rls | ✅ | T006, T011 | withTenantContext + route auth |
| NFR-3 reliability-fail-open | ✅ | T006, T008 | Graceful degradation, never block reply |
| NFR-4 observability | ✅ | T010, T011 | Langfuse + endpoint |
| NFR-5 token-budget | ✅ | T007 | Persona floor 500, feedback cap, RAG remainder |

## Constitution Alignment Issues

- **Principle VII (Artifact Versioning)**: Earlier stages not tagged. See F5. Not blocking.

## Unmapped Tasks

All 14 tasks map to at least one FR or NFR. No orphan tasks.

## Metrics

- Total Requirements: 15 (10 FR + 5 NFR)
- Total Tasks: 14
- Coverage % (requirements with ≥1 task): 100%
- Ambiguity count: 1 (F4 — recency decay)
- Duplication count: 0
- CRITICAL count: 0
- HIGH count: 0
- MEDIUM count: 4
- LOW count: 2

## VERDICT

```yaml
verdict: PASS
reviewer: analyze
reviewed_at: "2026-06-14T19:40:00Z"
commit: 4cb53d89fc4e78045680316d0caf642ee6c650b5
critical_count: 0
high_count: 0
medium_count: 4
low_count: 2
note: "Zero CRITICAL/HIGH. 4 MEDIUM findings are text/naming inconsistencies (spec vs plan) and one underspecified formula. None cause rework — plan compensates for all. Ready for external review."
```
