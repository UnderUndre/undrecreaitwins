# SpecKit Analyze: 004-validators

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-05-30T01:00:00Z
**Commit**: 65f4aee018b6c5e232ba82585e0d9e2fc7a4225a
**Artifacts**: spec.md, plan.md, tasks.md, data-model.md, contracts/validator.ts, research.md, quickstart.md, checklists/requirements.md

> Re-run after round-2 remediation (antigravity CRITICAL + trae-solo). The normative FRs were correctly fixed (FR-016 audit-best-effort, FR-017 rewrite-supersedes, new FR-024) — **but two Edge Case bullets still state the pre-fix claims**, so the spec now contradicts itself on two safety points. One of them (line 107) re-states the exact CRITICAL footgun antigravity flagged. Verdict: HIGH (mirror-miss, blocking, trivial to fix).

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Inconsistency | HIGH | spec.md:107 vs spec.md:136-139 (FR-016) | **Edge Cases bullet re-states the just-fixed CRITICAL footgun.** Line 107: "...run-persistence fails after a mutation → **original unmutated reply delivered** (FR-016b)." Revised FR-016c (line 139) says the **opposite**: on audit-persist failure after a safety remediation, deliver the **remediated (safe)** reply, never the flagged original. An implementer reading the edge case re-introduces the unsafe-delivery bug antigravity caught. | Rewrite line 107: "...orchestrator throws → safest reply delivered (remediated if flagged, else original); audit-persist failure → remediated reply delivered + retry, never the flagged original (FR-016b/c)." |
| F2 | Inconsistency | HIGH | spec.md:102 vs spec.md:140 (FR-017) | **Edge Cases bullet asserts the claim FR-017 explicitly removed as incorrect.** Line 102: "...the rewrite **sees accumulated text, so the disclaimer is not silently lost** (FR-017)." Revised FR-017 (line 140) states a total-rewrite **supersedes/discards** prior appends (and that "sees the accumulated text and preserves the disclaimer" "was incorrect and is removed"). Direct self-contradiction on composition semantics. | Rewrite line 102: "...a REWRITE (identity-guard) **supersedes** the prior append — the disclaimer is discarded, which is safe because the flagged content is replaced too (FR-017)." |
| F3 | Inconsistency | MEDIUM | spec.md:141 (FR-018) vs spec.md:139 (FR-016c) | FR-018 "MUST retain the original alongside the remediated output in its execution record" vs FR-016c "audit is **best-effort** … a failed write is logged and retried." If a write permanently fails, FR-018's MUST is unmet. The two are reconcilable but not reconciled in text. | Qualify FR-018: "When the execution record **is** persisted, it MUST contain both original and remediated content; write-failure handling is governed by FR-016c (retry; permanent loss logged as a tracked incident)." |
| E1 | Coverage | MEDIUM | spec.md:142 (FR-019) → tasks.md:T007c | FR-019's **new size-bound clause** ("if appending a disclaimer would exceed max-reply-length → apply `block` instead") has no task. T007c (false-promise remediation) lists append/block + fail-policy but is silent on the size-bound→block fallback. | Add to T007c: "if `append_disclaimer` would exceed the configured max-reply-length, fall back to `block` (FR-019)." |
| F4 | Inconsistency | LOW | research.md §3 vs plan.md:16 | research.md §3 "Assumptions Confirmed" still says "We build this in `packages/core` with **endpoints in `packages/api`**", but plan.md Target Platform was revised to "`packages/core` only … no `packages/api` surface". Stale Phase-0 note. | Update research.md §3 to "core-only in Phase 1; config via seed/SQL" or annotate as superseded by plan §Target Platform. |

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| FR-001 ordered post-gen pipeline | Yes | T005, T008 | |
| FR-002 inbound sanitize pre-gen | Yes | T010, T011 | |
| FR-003 prefilter EXACT/AMBIGUOUS | Yes | T007a | catalog ported per research §4 |
| FR-004 LLM judge int/ext + judge model | Yes | T003, T007b | |
| FR-005 fail-closed/open policy | Yes | T007b, T007c | |
| FR-006 confidence/timeout config | Yes | T007b, T013 | |
| FR-007 remediation + below-thresh + multi | Yes | T007c | |
| FR-008 identity-guard (word-boundary, Tier-1) | Yes | T004, T014, T015 | |
| FR-009 format-injection strip | Yes | T010 | |
| FR-010 latency model (conditional judge) | Yes | T007a, T010 | |
| FR-011 typed config + reject unknown | Yes | T004, T013 | |
| FR-012 dry-run | Yes | T012, T013 | |
| FR-013 observability + read-access | Yes | T002, T005 | read-ACL = no endpoint (Out-of-Scope) |
| FR-014 tenancy isolation | Yes | T002, T005, T018 | |
| FR-015 defaults (identity-guard dry-run) | Yes | T013, T017 | |
| FR-016 failure isolation (a/b/c) | Yes | T005 | **edge case 107 contradicts (F1)** |
| FR-017 composition + rewrite-supersedes | Yes | T005, T008, T016 | **edge case 102 contradicts (F2)** |
| FR-018 auditability orig+remediated | Yes | T002, T005 | tension w/ FR-016c (F3) |
| FR-019 empty-output guard + size-bound | Partial | T005 | size-bound→block clause untasked (E1) |
| FR-020 streaming-bypass telemetry | Yes | T019 | |
| FR-021 tenant-isolation enforcement | Yes | T002, T005, T018 | |
| FR-022 regex/judge resource bounds | Yes | T005, T010, T015 | |
| FR-023 audit-PII retention | Yes | T020 | |
| FR-024 empty-input guard | Yes | T010, T011 | newly tasked |

**Coverage: 24/24 functional requirements have ≥1 task (FR-019 partial — size-bound sub-clause untasked).**

## Constitution Alignment Issues

None. Standing order (reviewable `.sql`, no direct apply) honored by T002/T017/T020. WRAP (T007a/b/c). Principle VII now PASS in plan.md (tags exist). VI (this gate + 2 externals) is in progress — see below.

## Unmapped Tasks

None. All 22 tasks map to ≥1 requirement; dependency graph unchanged since the prior PASS run (no structural edits in round 2 — only task descriptions were enriched), so it remains acyclic with no orphans and no cross-agent shared-file race.

## Metrics

- Total Requirements: 24 (FR-001…FR-024) + 11 Success Criteria + 4 User Stories
- Total Tasks: 22
- Coverage % (FR with ≥1 task): 100% (24/24; FR-019 partial)
- Ambiguity count: 0
- Duplication count: 0
- CRITICAL count: 0
- HIGH count: 2
- MEDIUM count: 2
- LOW count: 1

## VERDICT

```yaml
verdict: HIGH
reviewer: analyze
reviewed_at: 2026-05-30T01:00:00Z
commit: 65f4aee018b6c5e232ba82585e0d9e2fc7a4225a
critical_count: 0
high_count: 2
medium_count: 2
low_count: 1
```
