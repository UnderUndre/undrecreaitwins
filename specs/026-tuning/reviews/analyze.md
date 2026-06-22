# SpecKit Analyze: 026-tuning

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-23T01:59:00+03:00
**Commit**: feedfe6
**Artifacts**: spec.md, plan.md, tasks.md, data-model.md, contracts/tuning-api.md, research.md, quickstart.md

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Underspecification | MEDIUM | spec.md:L25-33, tasks.md | Template bootstrap (Method B) listed in "What Needs Building" and in plan.md project structure (`template-bootstrap.ts`) but has zero tasks and no user story. Spec clarification says "Content task = separate from code" but no explicit deferral task exists. | Add a note in tasks.md Phase 9 or create a single TASK acknowledging Method B is deferred to a follow-up spec. |
| A2 | Underspecification | MEDIUM | spec.md:L150-154, tasks.md | SC-001 (60s draft) and SC-003 (10s sandbox) have no dedicated performance verification task. Tasks cover functional correctness but not timing SLAs. | Add a performance benchmark task in Phase 8 or 9 that measures and asserts timing constraints. |
| A3 | Underspecification | LOW | spec.md:L126, data-model.md, tasks.md:T001 | `diffSections` column exists in the schema (FR-001, T001) but no task computes or populates it. The field will remain NULL in all drafts. | Either add a task to compute diffs between previous and new config, or remove the column if not needed for v1. |
| A4 | Inconsistency | LOW | plan.md, tasks.md | Plan.md project structure lists `packages/core/src/services/tuning/template-bootstrap.ts` but no task creates it. Consistent with A1 (Method B deferred). | Remove from plan.md project structure or add a stub task. |
| A5 | Constitution Alignment | LOW | plan.md:L35-36 | Constitution Check Principle VI (Cross-AI Review Gate) marked as DEFERRED. This is correct — the gate is met before implement, not during plan. No action needed. | — |
| A6 | Ambiguity | LOW | spec.md:L84 | "Engine periodically (or on-demand) analyzes" — the spec says both periodic and on-demand. Research.md §4.1 and FR-010 clarify on-demand for v1. Consistent. | — |
| A7 | Coverage Gap | LOW | spec.md:L167 | Extraction prompt content is "separate artefact (`extraction-prompt.md`), iterated offline." T013 creates a hardcoded prompt with "admin-editable deferred." The coding standards §15.1 recommend admin-editable prompts. | Consider adding a follow-up task to migrate the hardcoded prompt to an admin-editable setting. |

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| FR-001 (DB Schema) | ✅ | T001, T002 | Drizzle schema + migration |
| FR-002 (Generate) | ✅ | T009 | Route handler with fire-and-forget |
| FR-003 (Poll + Reaper) | ✅ | T010, T030 | Poll route + reaper logic |
| FR-004 (List) | ✅ | T011 | List drafts with status filter |
| FR-005 (Review) | ✅ | T017 | Advisory review endpoint |
| FR-006 (Activate) | ✅ | T014, T015 | Pipeline + route |
| FR-007 (Rollback) | ✅ | T016 | Rollback with LIFO semantics |
| FR-008 (Sandbox Preview) | ✅ | T018, T019 | Overlay service + route |
| FR-009 (Interview) | ✅ | T020, T021 | State machine + routes |
| FR-010 (Proposals) | ✅ | T022, T023, T032 | Analyzer + routes + expired guard |
| FR-011 (Concurrent Lock) | ✅ | T026 | 409 on concurrent generate |
| FR-012 (Tenant Isolation) | ✅ | T029 | Cross-tenant → 404 |
| FR-013 (Quality Gate) | ✅ | T012 | Validator dry-run after extraction |
| SC-001 (60s draft) | ✅ | T024, T033 | Timeout handling + test |
| SC-002 (3s activate) | ✅ | T015 | Synchronous activate route |
| SC-003 (10s sandbox) | ✅ | T019 | Sandbox route |
| SC-004 (block-rate <30%) | ✅ | T012 | Quality gate |
| SC-005 (proper error codes) | ✅ | T034–T047 | Edge case tests |
| US1 (Doc Extraction) | ✅ | T008–T013, T033–T036 | Generation pipeline + tests |
| US2 (Activate/Rollback) | ✅ | T014–T017, T037–T039 | Activate pipeline + tests |
| US3 (Interview) | ✅ | T020–T021, T042 | State machine + test |
| US4 (Proposals) | ✅ | T022–T023, T043–T044 | Analyzer + tests |
| US5 (Sandbox Preview) | ✅ | T018–T019, T040–T041 | Overlay + tests |
| Method B (Template Bootstrap) | ❌ | — | Deferred per spec clarification |

## Constitution Alignment Issues

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Source of Truth Discipline | ✅ PASS | No `.claude/` changes |
| II. Transformer, Not Fork | ✅ PASS | No new AI target |
| III. Protected Slots | ✅ PASS | N/A |
| IV. SemVer Discipline | ✅ PASS | No CLI version bump |
| V. Token Economy | ✅ PASS | No new agents/skills |
| VI. Cross-AI Review Gate | ⚠️ DEFERRED | Gate will be met before implement (this analyze is the first step) |
| VII. Artifact Versioning | ✅ PASS | Tags created: `plan/026-tuning/v1`, `tasks/026-tuning/v1` |
| VIII. Self-Maintaining Knowledge | ✅ PASS | N/A |

## Unmapped Tasks

All 50 tasks (T001–T050) map to at least one FR, SC, or US. No unmapped tasks.

## Agent Routing Validation

| Check | Status |
|-------|--------|
| All tasks have [AGENT] tag | ✅ PASS |
| Agent tag consistent with file path | ✅ PASS |
| Dependency Graph section exists | ✅ PASS |
| Dependency syntax valid (→ and + only) | ✅ PASS |
| No chained arrows on single line | ✅ PASS |
| No orphan task IDs in Dependencies | ✅ PASS |
| No circular dependencies | ✅ PASS |
| Parallel Lanes table exists | ✅ PASS |
| Agent Summary table exists | ✅ PASS |
| Lane assignments match agent tags | ✅ PASS |
| E2E/SEC tasks depend on impl tasks (not vice versa) | ✅ PASS |
| No shared file conflicts between agents | ✅ PASS |

## Metrics

- Total Requirements (FR): 13
- Total User Stories: 5
- Total Success Criteria: 5
- Total Tasks: 50
- Coverage % (requirements with ≥1 task): 100% (13/13 FR, 5/5 US, 5/5 SC)
- Ambiguity count: 1 (A6 — minor, resolved in research.md)
- Underspecification count: 3 (A1, A2, A3)
- Inconsistency count: 1 (A4)
- Constitution issues: 0
- CRITICAL count: 0
- HIGH count: 0
- MEDIUM count: 2 (A1, A2)
- LOW count: 5 (A3, A4, A5, A6, A7)

## VERDICT

```yaml
verdict: PASS
reviewer: analyze
reviewed_at: 2026-06-23T01:59:00+03:00
commit: feedfe6
critical_count: 0
high_count: 0
medium_count: 2
low_count: 5
```

## Next Actions

**Verdict: PASS** — No CRITICAL or HIGH findings. All 13 functional requirements, 5 user stories, and 5 success criteria have task coverage. Agent routing, dependency graph, and constitution alignment all pass validation.

**Top 2 MEDIUM findings:**

1. **A1**: Template bootstrap (Method B) is listed in spec + plan but has zero tasks. Spec clarification says "Content task = separate from code" — consider adding an explicit deferral note.
2. **A2**: SC-001 (60s) and SC-003 (10s) timing SLAs lack dedicated performance verification tasks.

**Recommended next step**: Ready for `/speckit.review` from external AIs (Codex Desktop, Antigravity, Gemini, Copilot). Need ≥2 PASS verdicts before `/speckit.implement` per constitution Principle VI.

**Optional remediation**: Would you like me to suggest concrete remediation edits for the top 2 MEDIUM issues? (Do NOT apply them automatically.)
