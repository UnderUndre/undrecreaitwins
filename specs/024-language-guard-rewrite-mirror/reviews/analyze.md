# SpecKit Analyze: 024-language-guard-rewrite-mirror

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-20T20:15:00Z
**Commit**: cc9f29b46b5c7731330dffb885510b877db87109
**Artifacts**: spec.md (157 lines), plan.md (198 lines), tasks.md (81 lines), .specify/memory/constitution.md (148 lines)

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| A1 | Coverage | MEDIUM | spec.md:79 (FR-004), tasks.md:16 (T3) | FR-004 (outbound detect orchestration) has no explicit task. T3 covers FR-002b (langid same-script sub-step) but not the full FR-004 detection flow (script detect + langid orchestration). | Add FR-004 to T3 scope, or note that Phase 1 script-detect is pre-existing and FR-002b covers the delta. |
| A2 | Coverage | MEDIUM | spec.md:84 (FR-009), tasks.md:55,62 (T4,T5) | FR-009 (graceful degradation) split implicitly across T4/T5 verify sections but not in any task's FR list or desc. | Add FR-009 to T4 desc ("implement degradation logic for langid/translate failures") or T5. |
| A3 | Coverage | MEDIUM | spec.md:95 (NFR-4), tasks.md:37 (T1) | NFR-4 runtime behavior (`allowPlatformModelRouting=false` + `remediation='translate'` → strip-block) not in any task. T1 adds the config field but the runtime gate is uncaptured. | Add to T4 desc: "check `allowPlatformModelRouting` before platform model calls; if false → skip to strip-block." |
| A4 | Inconsistency | MEDIUM | spec.md:118 (§7), spec.md:87 (FR-012), plan.md:112 (data-model) | RemediationResult type values diverge: spec §7/FR-012 list 5 values (`pass|translated|regenerated|stripped|blocked`), plan data-model lists 7 (`+degraded|skipped`). `degraded` and `skipped` were added in review fixes (F2, F14) to plan but not propagated to spec §7 and FR-012. | Update spec §7 RemediationResult and FR-012 audit types to include `degraded` and `skipped`. |
| A5 | Underspecification | MEDIUM | spec.md:93 (NFR-2), tasks.md:55 (T4) | NFR-2 latency budget enforcement not in T4 verify criteria. Plan.md has the budget formula and skip-regenerate rule, but T4 doesn't explicitly verify it's enforced. | Add to T4 verify: "latency budget check enforced — if projected total exceeds budget, skip regenerate per NFR-2." |
| A6 | Format | LOW | tasks.md:9-20 | Tasks use named agents (`backend-specialist`, `test-engineer`) in dispatch table instead of `[BE]`/`[DB]` bracket tags expected by analyze convention. Functionally equivalent. | Optionally convert to bracket tags for convention compliance, or document as intentional project style. |
| A7 | Format | LOW | tasks.md:22-27 | No section literally named "Dependency Graph" — equivalent info exists in "Blocked By" column + "Parallel Lanes" section. | Optionally rename or add a "Dependency Graph" section with `→`/`+` notation. |

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| FR-001 (target resolution) | Yes | T3 | Full coverage |
| FR-002 (langid inbound) | Yes | T3 | Full coverage |
| FR-002b (outbound same-script detect) | Yes | T3 | Full coverage |
| FR-003 (dynamic directive) | Yes | T3 | Full coverage |
| FR-004 (outbound detect) | Partial | T3 | Only FR-002b sub-step explicit; script-detect is Phase 1 pre-existing (A1) |
| FR-005 (translate-pass) | Yes | T4 | Full coverage |
| FR-006 (regenerate escalation) | Yes | T4 | Full coverage |
| FR-007 (last-resort fallback) | Yes | T4 | Full coverage |
| FR-008 (buffered delivery) | Yes | T5 | Full coverage |
| FR-009 (graceful degradation) | Partial | T4, T5 | Split across verify sections, not in FR list (A2) |
| FR-010 (supported languages) | Yes | T2 | Full coverage |
| FR-011 (config additions) | Yes | T1 | Full coverage |
| FR-012 (audit) | Yes | T6 | Type values inconsistent with spec (A4) |
| FR-013 (agentic-path) | Yes | T5 | Full coverage (resolved in review F2) |
| NFR-1 (cost) | Yes | T0, T3 | Implicit in langid gate logic |
| NFR-2 (latency) | Partial | T0, T4 | Measured in R2; enforcement not in T4 verify (A5) |
| NFR-3 (fidelity) | Yes | T4 | Full coverage |
| NFR-4 (isolation/governance) | Partial | T1 | Config field in T1; runtime gate missing (A3) |
| NFR-5 (backward compat) | Yes | T1 | Default `strip-block` captured |

## Constitution Alignment Issues

None. Principles I–V correctly marked N/A (engine fork, not CLI). VI and VII marked PASS with justification. No violations.

## Unmapped Tasks

None. All 8 tasks (T0–T7) map to at least one FR or NFR.

## Metrics

- Total Requirements: 19 (14 FRs including FR-002b + 5 NFRs)
- Total Tasks: 8 (T0–T7)
- Coverage % (requirements with ≥1 task): 100%
- Partial coverage: 4/19 (FR-004, FR-009, NFR-2, NFR-4)
- Ambiguity count: 0
- Duplication count: 0
- CRITICAL count: 0
- HIGH count: 0
- MEDIUM count: 5
- LOW count: 2

## VERDICT

```yaml
verdict: PASS
reviewer: analyze
reviewed_at: 2026-06-20T20:15:00Z
commit: cc9f29b46b5c7731330dffb885510b877db87109
critical_count: 0
high_count: 0
medium_count: 5
low_count: 2
```
