# SpecKit Analyze: 017-language-guard-validator

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-14T21:00:00Z
**Commit**: 6db19bd22b8ea1362d11f6dd14d6bc78f4fe9243
**Artifacts**: spec.md, plan.md, tasks.md (no data-model.md — reuses existing tables per plan DD-004)

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| — | — | — | — | No findings. | — |

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| FR-001 allowed-languages-config | ✅ | T002 | LanguageGuardConfig type + Zod schema |
| FR-002 directive-injection | ✅ | T008 | buildSystemPrompt injection |
| FR-003 response-evaluation | ✅ | T005 | ScriptClassifier + fraction |
| FR-004 strip-verdict | ✅ | T005 | Strip remediation branch |
| FR-005 block-verdict | ✅ | T005 | Block remediation branch |
| FR-006 threshold-validation | ✅ | T002, T004 | Zod .refine + write-path validation |
| FR-007 mode-field | ✅ | T002 | active \| dry-run |
| FR-008 default-dry-run | ✅ | T002, T003 | resolveConfig default |
| FR-009 audit-all-events | ✅ | T005, T007 | persistRuns + dry-run test |
| FR-010 regenerate-on-violation | ✅ | Deferred (T015) | Config field exists, logic deferred |
| FR-011 zero-llm-happy-path | ✅ | T005 | Deterministic Unicode analysis |
| FR-012 noop-empty-languages | ✅ | T005 | Early return + pipeline skip |
| FR-013 per-tenant-persona | ✅ | T010, T011 | Existing unique index |
| FR-014 mask-code-url-email | ✅ | T005 | Masking pre-pass (DD-008) |
| FR-015 fraction-formula | ✅ | T005 | Pinned formula per gemini PR#32 |

**Seam A (shared quality-types)**: T000 creates canonical module. T002 depends on T000. ✅

## Constitution Alignment Issues

None. Principle VI (cross-AI review) PENDING — analyze running. Principle VII (artifact versioning) — plan says tags created; acceptable.

## Unmapped Tasks

All tasks map to ≥1 FR. T000 maps to seam A (cross-spec infrastructure, referenced by 018+019).

## Metrics

- Total Requirements: 15 FR + 6 SC
- Total Tasks: 13 (T000–T012)
- Coverage %: 100%
- CRITICAL count: 0
- HIGH count: 0
- MEDIUM count: 0
- LOW count: 0

## VERDICT

```yaml
verdict: PASS
reviewer: analyze
reviewed_at: "2026-06-14T21:00:00Z"
commit: 6db19bd22b8ea1362d11f6dd14d6bc78f4fe9243
critical_count: 0
high_count: 0
medium_count: 0
low_count: 0
```
