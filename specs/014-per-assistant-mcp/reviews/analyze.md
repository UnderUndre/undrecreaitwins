# SpecKit Analyze: 014-per-assistant-mcp

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-08T02:41:56+03:00
**Commit**: 1248b4afb7e3b609c91411cc7f29b44af8e320fb *(014 artifacts untracked — pre-commit)*
**Artifacts**: spec.md, plan.md, tasks.md, research.md, data-model.md, contracts/{mcp-catalog-api,mcp-broker}.contract.md, quickstart.md

## Summary

Coherent and security-led: the broker-through-gateway design preserves 010's sole-authority invariant, SSRF/secrets/RLS are specified, and coverage is complete (13 FR + 5 SC → all mapped). No CRITICAL or HIGH. Three MEDIUMs worth fixing before implement — the most actionable is a dependency-graph gap (T010 has no incoming edge) and the write-classification default. Snapshots are absent but that's expected pre-commit (not a Principle VII violation yet).

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Inconsistency / Routing | MEDIUM | tasks.md Dependency Graph vs Parallel Lanes | **T010 has no incoming dependency** in the Dependency Graph, yet Lane 4 + Implementation Strategy show `T008 → T009 → T010`. As written, T010 (the broker wiring that consumes T009's output) is schedulable at T0. | Add edge **`T009 → T010`** (and arguably `T008 → T010`) to the Dependencies section so the graph matches the lanes. |
| F2 | Atomicity (WRAP) | MEDIUM | tasks.md T010 | T010 bundles edits to **three** files (`mcp-server.ts` + `tool-gateway.ts` + `hermes-executor.ts`) **and** the heaviest piece (CQ3 external write-treatment). Risks the constitution's WRAP <500 LOC / one-concern rule. | Split: T010a = inject brokered tools (mcp-server + hermes-executor build); T010b = external write-treatment in tool-gateway. |
| F3 | Underspecification / Security | MEDIUM | research.md §c; data-model.md; mcp-broker.contract.md | Un-annotated external tool defaults to `isWrite:false` → **no idempotency reservation**. A mutating-but-unannotated tool could **double-execute on retry** (the `requiresConfirmation:true` default mitigates but doesn't eliminate). | Require explicit write/read classification **before** a tool is callable, OR default unknown tools to write-treatment (idempotency on) until classified. |
| F4 | Ambiguity | LOW | drizzle migration `00NN_per_assistant_mcp.sql` | Filename uses `00NN` placeholder; also must land in `drizzle/meta/_journal.json` (PR #24 gemini #14 lesson) or drizzle-kit won't track it. | Resolve `NN` to the next sequence at impl; generate via drizzle-kit or add the journal entry. |
| F5 | Ambiguity | LOW | research.md §d; data-model.md | Discovery cache TTL value not pinned ("TTL"). | Pick a concrete default (e.g. 300 s) + admin `rescan` invalidation (already specified). |
| F6 | Constitution (VII) | LOW | git tags | No `spec/clarify/plan/tasks` snapshots for 014. **Expected** — artifacts are untracked (pre-commit); snapshots can only point at a commit. | Tag via `snapshot-stage` once committed, before `/speckit.implement`. Not a violation at this stage. |
| F7 | Cross-feature | LOW | spec Out of Scope; tasks note | The config API (T004) has **no in-repo consumer** — the admin UI is in `ai-twins`. Risk of an API built but unused/uncoordinated. | Coordinate the `ai-twins` admin slice; keep the API contract (mcp-catalog-api) as the shared boundary. |

## Coverage Summary

| Requirement | Has Task? | Task IDs |
|---|---|---|
| FR-001 catalog registration | yes | T004, T003 |
| FR-002 per-assistant bindings | yes | T004 |
| FR-003 secrets encrypted | yes | T004, T008, T013 |
| FR-004 broker through gateway | yes | T009, T010, T006, T013 |
| FR-005 SSRF reg+connect | yes | T004, T008, T013 |
| FR-006 HTTP/stdio gate | yes | T002, T004, T003 |
| FR-007 degrade not fail | yes | T011, T012 |
| FR-008 tenant isolation (RLS) | yes | T002, T012, T013 |
| FR-009 untrusted_tool_result fence | yes | T008, T010, T006 |
| FR-010 namespacing | yes | T009 |
| FR-011 external write-treatment | yes | T010, T006 |
| FR-012 observability | yes | T011 |
| FR-013 discovery cache (no N+1) | yes | T009, T011, T012 |
| SC-001..005 | yes | T003, T006, T012 |

## Constitution Alignment Issues

- **Principle VI (Cross-AI Review Gate)** — first gate (this); ≥2 external `/speckit.review` PASS still required before implement.
- **Principle VII (Artifact Versioning)** — snapshots pending commit (F6); not a violation pre-commit.
- **WRAP atomicity** (dev-workflow) — T010 over-bundled (F2).
- Principles I–V/VIII govern the upstream template; N/A here.

## Unmapped Tasks

None. T001–T014 all map to a requirement, story, or setup/polish role.

## Metrics

- Total Requirements: 13 functional (+ 5 success criteria)
- Total Tasks: 14
- Coverage % (FR with ≥1 task): **100%** (13/13)
- Ambiguity count: 2 (F4, F5)
- Duplication count: 0
- CRITICAL count: 0
- HIGH count: 0
- MEDIUM count: 3
- LOW count: 4

## VERDICT

```yaml
verdict: PASS
reviewer: analyze
reviewed_at: 2026-06-08T02:41:56+03:00
commit: 1248b4afb7e3b609c91411cc7f29b44af8e320fb
critical_count: 0
high_count: 0
medium_count: 3
low_count: 4
note: "PASS with 3 MEDIUM advisories; snapshots pending commit (expected pre-commit)"
```
