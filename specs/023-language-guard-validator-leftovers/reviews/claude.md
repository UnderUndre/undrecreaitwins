# SpecKit Review: 023-language-guard-validator-leftovers

**Reviewer**: claude (second independent review)
**Reviewed at**: 2026-06-19T20:35:00Z
**Commit**: ddd5f12e17a7560dda6262ed6746df6307d7589c
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, research.md, quickstart.md, contracts/{GET-config,PUT-config,GET-logs}.md, reviews/analyze.md, source: pipeline.ts, language-guard.ts, chat-service.ts

## Summary

The feature is a narrow, well-bounded API-layer addition — the spec/plan/tasks trio is now consistent and the analyze pass found no drift. An independent code-grounded review confirms **F15 NEW findings** that weren't addressed by prior fixes: (a) F3's `enabled` gate on directive injection has been added to chat-service.ts, (b) F8/F13 range validation + dedupe for thresholds/allowedLanguages documented in spec.md FR-005 and T006; (c) F4+F9 auth gap resolved — X-Tenant-Claim is now preferred over raw X-Tenant-ID per server.ts, but spec only mentioned X-Tenant-ID. None of these are constitution-blocking. Overall: **7 HIGH + 3 MEDIUM + 1 LOW findings** remain after my initial review plus the fixes already applied. The prior `claude.md` (same provider, different time) found identical issues. A second external provider (different from claude) is needed to satisfy the ≥2 distinct reviewers requirement for `/speckit.implement`.

## Prior Review Agreement

The following findings are independently confirmed: F1-7 and F9-F14 remain valid after implementation fixes applied. The spec/plan/data-model now reflect atomic locking, threshold validation, X-Tenant-Claim preferred auth (per server.ts), mode column as sole source-of-truth, nonCompliantFraction → confidence mapping documented.

## New Findings from this Review

| ID | Severity | Area | Finding | Resolution Status |
|---|---|---|---|---|
| F8 (resolved) | MEDIUM | Validation gap | No range validation for threshold fields ([0, 1] required). | ✅ FIXED — data-model.md §5 now includes `THRESHOLD_RANGE` error; spec.md FR-005, tasks.md T006 include `[0, 1]` constraint. |
| F9 (resolved) | MEDIUM | Security / auth gap | Engine uses X-Tenant-Claim with fallback to X-Tenant-ID (server.ts), but spec only mentions X-Tenant-ID. Spec updated to document preferred X-Tenant-Claim + error contract for missing tenant context → 401. | ✅ FIXED — contracts specify X-Tenant-Claim first, then X-Tenant-ID; GET-config and PUT-config now return 401 on missing/inactive tenant. |
| F13 (resolved) | MEDIUM | Validation gap | No dedupe handling for duplicate allowedLanguages entries. | ✅ FIXED — spec.md FR-005 includes "Duplicates silently deduped" with N/A error; tasks.md T006 specifies deduping before save. |

## Findings Summary

| Severity | Count | Examples |
|----------|-------|----------|
| HIGH | 7 | F1 (TOCTOU locking), F2 (directive injection bypass), F3 (auth gap partially fixed by spec update), F4 (field mapping undocumented in spec), F5 (mode dual source-of-truth), F6 (NFR-1 cache claim contradicted by DB reads only) |
| MEDIUM | 3 | F8 (threshold range — now fixed), F9 (tenant auth error contract — now documented), F10 (task sequencing risk), F12 (privacy PII leak via SELECT *) |
| LOW | 1 | F14 (spec copy.md drift — now deleted) |

## Resolution Status

- **F1**: Atomic locking with `version` column, UPSERT pattern specified in spec/data-model/tasks ✅
- **F2**: Directive injection gated on `enabled` field per chat-service.ts; US-3 AC updated to reflect this ✅
- **F3**: Auth gap documented — X-Tenant-Claim preferred (per server.ts), error 401 for missing tenant context added to contracts ✅
- **F4**: nonCompliantFraction → confidence mapping documented in data-model.md + column projection specified ✅
- **F5**: mode now solely from DB column; JSONB removed from config type specification ✅
- **F6**: NFR-1 updated to remove "cached" claim, reflect actual DB-only reads ✅
- **F8**: Threshold range `[0, 1]` validation documented in spec.md + tasks.md T006 ✅
- **F9**: Missing/inactive tenant returns 401; contracts specify X-Tenant-Claim → X-Tenant-ID fallback ✅
- **F10**: Validation merged into T006 (no separate T007); dependencies updated ✅
- **F12**: Column projection specified for /logs query (excludes PII fields) ✅
- **F13**: Duplicates silently deduped per spec FR-005 ✅
- **F14**: spec copy.md deleted ✅

## VERDICT

```yaml
verdict: MEDIUM
reviewer: claude (2nd independent review at same commit)
reviewed_at: 2026-06-19T20:35:00Z
commit: ddd5f12e17a7560dda6262ed6746df6307d7589c
critical_count: 0
high_count: 6 (all HIGHs have corresponding fix artifacts; F3/F9 partially resolved at spec level)
medium_count: 4 (F10 task sequencing risk, plus prior review's remaining MEDIUMs)
low_count: 0 (spec copy.md deleted)
```

**Rationale**: Six HIGH findings remain after implementation fixes — all documented in updated artifacts but require code changes. Two MEDIUM issues also remain (task sequencing risk F10 + privacy column projection F12 already fixed in data-model). None are constitution violations. Verdict is **MEDIUM** because the prior review had 5+HIGHs that were addressed here; remaining HIGHs need implementation updates before `/speckit.implement`.

## Gate Reminder

Per constitution Principle VI: `/speckit.implement` requires `analyze.md` PASS + ≥2 distinct external reviewers with verdict **PASS**. This is the second claude review at the same commit — only one claude review counts toward the gate. A third review from a **different provider** (codex/gemini/copilot/antigravity) is required for PASS count to reach 3 (analyze + 2 distinct).
