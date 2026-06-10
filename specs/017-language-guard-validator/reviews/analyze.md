# SpecKit Analyze: 017-language-guard-validator

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-10T19:45:00Z
**Commit**: 9982e6471d7d3590db26848edc27f0d6da05534d
**Artifacts**: spec.md, plan.md, tasks.md, research.md

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Ambiguity | LOW | spec.md FR-003, plan.md DD-002 | `nonCompliantFraction` is mentioned in spec acceptance scenarios but not formally defined as a field on `LanguageGuardResult` entity. Plan DD-002 computes it but doesn't name the output field explicitly. | Consider adding `nonCompliantFraction` to `Verdict.confidence` field (reuse existing field with different semantics) or document that it maps to a new property on the audit row. Low impact — implementation will resolve. |
| A2 | Ambiguity | LOW | spec.md Edge Cases, plan.md DD-002 | Spec says "code blocks in response" are handled via threshold absorption but doesn't define what happens with fenced code blocks (``` ... ```). The backticks are ASCII (common), but content inside may be in any script. | Acceptable as-is — code block content counts toward fraction like any other text. No action needed unless product wants explicit code-block exclusion. |
| U1 | Underspecification | LOW | tasks.md T002 | `LanguageGuardConfig` includes `regenerateOnViolation: boolean` but DD-007 says it's deferred/ignored. The config field exists but no code reads it. This is forward-compatible but the Zod schema should accept the field silently. | T002 already covers this (field in interface, default `false`). No action — documented in DD-007. |
| D1 | Duplication | LOW | tasks.md T005 | T005 description is long (~15 lines) combining ScriptClassifier + LanguageGuardValidator + all three remediation branches. Consider splitting ScriptClassifier into a separate task for cleaner agent dispatch. | Acceptable as-is — single-file implementation, one agent. No structural harm. |

No CRITICAL findings.
No HIGH findings.

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| FR-001 (per-persona allowedLanguages) | YES | T002, T005, T010 | Covered |
| FR-002 (inject language directive) | YES | T008, T009 | Covered |
| FR-003 (evaluate response for non-compliant scripts) | YES | T005, T006 | Covered |
| FR-004 (strip verdict) | YES | T005, T006 | Covered |
| FR-005 (block verdict) | YES | T005, T006 | Covered |
| FR-006 (stripThreshold ≤ blockThreshold) | YES | T002, T004 | Covered — validation in Phase 1 |
| FR-007 (mode: active / dry-run) | YES | T003, T007 | Covered |
| FR-008 (default mode = dry-run) | YES | T003 | Covered |
| FR-009 (audit all events) | YES | T003, T005, T006, T007 | Covered — pass audit for non-empty config clarified |
| FR-010 (regenerateOnViolation) | DEFERRED | — | DD-007: deferred to follow-up, config field forward-compatible |
| FR-011 (zero LLM calls on happy path) | YES | T005 | Deterministic by design |
| FR-012 (empty allowedLanguages = no-op) | YES | T003, T005, T006 | Covered |
| FR-013 (per-tenant-persona scoping) | YES | T010, T011 | Covered |

## Constitution Alignment Issues

No constitution violations detected. All 8 principles PASS or are process-gates (VI, VII) handled at review/commit time.

## Unmapped Tasks

None. All 12 active tasks map to at least one requirement or user story.

## Metrics

- Total Requirements: 13 (FR-001 through FR-013)
- Total Tasks: 12 active + 1 deferred = 13
- Coverage % (requirements with ≥1 task): 92% (12/13; FR-010 deferred)
- Ambiguity count: 2 (A1, A2 — both LOW)
- Duplication count: 1 (D1 — LOW)
- CRITICAL count: 0
- HIGH count: 0
- MEDIUM count: 0
- LOW count: 4

## VERDICT

```yaml
verdict: PASS
reviewer: analyze
reviewed_at: "2026-06-10T19:45:00Z"
commit: 9982e6471d7d3590db26848edc27f0d6da05534d
critical_count: 0
high_count: 0
medium_count: 0
low_count: 4
```

## Previous Findings Resolution

All 14 findings from the initial analyze run have been resolved:

| Original ID | Resolution |
|-------------|-----------|
| C1 (HIGH) | FR-010 `regenerateOnViolation` explicitly deferred (DD-007, Deferred section in tasks.md) |
| I1 (HIGH) | `"zh" → [Han]` — typo fixed in plan.md DD-001 |
| U1 (HIGH) | Error handling for DB query in directive injection added to T008 + test in T009 + DD-003 paragraph |
| G3 (HIGH) | Config validation (T004) moved to Phase 1, before core validator |
| C2 (MEDIUM) | FR-009 pass audit clarified in DD-005, T005, T006 |
| I2 (MEDIUM) | DD-005 now explicitly states "no interface change" |
| I3 (MEDIUM) | T003 now includes pipeline-level skip logic in description |
| A1 (MEDIUM) | Pass audit semantics clarified (empty config → no audit, non-empty → audit) |
| A2 (LOW) | DD-007 resolves MAY vs MUST — deferred with rationale |
| U2 (MEDIUM) | `detectedScripts` maps to `matchedPatterns` — documented in T002 |
| U3 (LOW) | Zod schema creation included in T002 |
| D1 (LOW) | T005+T006 merged into single T005 |
| G1 (MEDIUM) | Former T008 merged into T007 |
| G2 (MEDIUM) | Agent Summary count corrected: [BE] = 10 |
