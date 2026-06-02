# SpecKit Analyze: 010-hermes-executor

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-03T02:30:00Z
**Commit**: 3804a9e23551bd163d1f24cdf3e1df6cd6ce0f4f *(010 dir UNTRACKED — uncommitted)*
**Branch**: main
**Artifacts**: spec.md, plan.md, tasks.md, research.md, data-model.md, contracts/hermes-executor.contract.md, quickstart.md

## Context

First analyze of 010 (Hermes agentic executor). Decisions locked via brainstorm + clarify (Topology C, always-agent, real write-actions v1, self-host MIT, Honcho+SoR, spawn/hibernate). License gate is GREEN (research §a: `hermes-agent` MIT). Honest scan found 3 MEDIUM design-depth gaps (no CRITICAL/HIGH).

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| I1 | Inconsistency | MEDIUM | spec.md FR-001 vs US2; tasks T008/T013 | FR-001 says scripted → **deterministic** path; US2 says "**Hermes may fill slot text under stage control**". Are scripted turns pure-template or Hermes-generated-under-stage-constraint? Router (T008) behaviour for a mid-funnel off-script question is unpinned. | Pin the "structured agent" boundary: engine owns stage CONTROL; specify whether in-stage TEXT is template or Hermes-constrained, and how an off-script question mid-funnel is handled. |
| U1 | Underspecification (correctness) | MEDIUM | spec FR-012; data-model `action_audit`; contract §tool-gateway; T015/T022 | Write-action **idempotency protocol** is asserted (`UNIQUE(idempotencyKey)`, "never double-execute") but not **designed**. The hard part — reserve-key-**before** the external side-effect + handle "executed but crashed before recording" (at-most-once for external writes) — is undefined. For real CRM/booking writes this is the correctness crux. | Design the protocol in plan before T015: reserve idempotency row → execute → finalize; define replay semantics + downstream idempotency keys. Test crash-between-execute-and-record (extend T022). |
| U2 | Underspecification | MEDIUM | spec FR-004; data-model §Honcho; T004 | "Honcho reconstructible from SoR" is asserted but the **reconstruction mechanism** is undefined (seed on spawn from last-N messages + annotations? lazy rebuild? accept cold memory?). | Define what "reconstructible" means operationally on spawn/hibernate-resume; add to T004. |
| A1 | Ambiguity | LOW | spec FR-007 (C1); data-model `agentConfig.highStakesActions` | "High-stakes actions" = an operator-configured per-persona list, not a system criterion. Acceptable, but make explicit it's config-defined (no built-in classification). | One line: high-stakes = membership in `agentConfig.highStakesActions`. |
| A2 | Ambiguity | LOW | spec NFR (latency/cost); quickstart env | Loop/token caps, per-tenant budget, p95 latency, warm-pool "hot" — values undefined (tunable env). Acceptable as tunable defaults. | State starting defaults (e.g. loopCap=N) or mark explicitly tunable. |
| F1 | Inconsistency (cosmetic) | LOW | spec glossary "Dožim" vs data-model/tasks `kind:'dozhim'` | Transliteration drift (Dožim / dozhim). | Pick one token for the enum value. |
| X1 | Cross-spec drift | LOW | specs/main/requirements.md §2.2 vs 010 FR-004 | 010 drops Letta for Honcho; `specs/main/requirements.md` still lists "Memory: Letta" (architecture.md already notes the supersession). Principle VIII living-spec drift. | Update requirements.md §2.2 (Letta → Honcho working-mem + Postgres SoR) when 010 lands. |

*Overflow*: none (7 findings).

## Coverage Summary

| Requirement | Has Task? | Task IDs |
|-------------|-----------|----------|
| FR-001 routing | Yes | T008, T013 |
| FR-002 agentic invocation + context | Yes | T005, T011 |
| FR-003 validators outbound gate | Yes | T007, T011 |
| FR-004 memory (Honcho+SoR) | Yes | T004, T000b |
| FR-005 lifecycle | Yes | T009, T023 |
| FR-006 proactivity via 009 | Yes | T017 |
| FR-007 tool sandbox + action permission | Yes | T006, T015 |
| FR-008 metering + budget + cap | Yes | T007, T019 |
| FR-009 fallback | Yes | T007, T011, T012 |
| FR-010 status streaming | Yes | T010, T005 |
| FR-011 audit | Yes | T003, T006, T015 |
| FR-012 abort/idempotency | Yes | T015, T022 (protocol depth — U1) |
| SC-001..005 | Yes | T012/T018/T021/T012/T019+T022 |

100% FR coverage; NFR (cost/isolation/security/reliability/observability/latency) all tasked.

## Constitution Alignment Issues

- **None violated.** Multi-tenant RLS + Honcho namespace + tool tenant-scope (T021); secrets server-side (NFR-2, tool-gateway holds creds); reviewed `.sql` (T003); idempotency for write-actions (FR-012 — protocol depth U1, not a violation); engine server-to-server.
- **VI (Cross-AI Review)** — PENDING: ≥2 external PASS before implement.
- **VII (Versioning)** — PENDING: 010 untracked; commit + `analyze/010-hermes-executor/v1`.
- **VIII (living spec)** — minor drift X1 (requirements.md Letta).

## Unmapped Tasks
None. T000a/b (gates), T001/T002 (setup), T019-T023 (NFR/polish) all map to FR/NFR or are gates/support.

## Metrics
- Total Requirements: 12 FR + 6 NFR + 5 SC
- Total Tasks: 25 (T000a/b + T001–T023)
- Coverage % (FR with ≥1 task): 100%
- Ambiguity: 2 · Duplication: 0
- CRITICAL: 0 · HIGH: 0 · MEDIUM: 3 · LOW: 4

## VERDICT

```yaml
verdict: PASS
reviewer: analyze
reviewed_at: "2026-06-03T02:30:00Z"
commit: 3804a9e23551bd163d1f24cdf3e1df6cd6ce0f4f
critical_count: 0
high_count: 0
medium_count: 3
low_count: 4
```

**Rationale**: Internally consistent and 100%-covered. The guardrail-first design (engine-mediated tool-gateway, validators outbound gate, per-tenant budget/loop-cap, tenant isolation, fallback) correctly contains the always-agent + real-write-actions risk; the Phase-0 gates (T000a hermes API, T000b Honcho isolation) front-load the unknowns; license is MIT-clear. Zero CRITICAL/HIGH → PASS. The 3 MEDIUM are design-depth refinements — **U1 (write-action idempotency protocol) is the one to nail before implementing T015** (external double-write is the severe failure mode), I1 (scripted-vs-Hermes boundary) and U2 (Honcho reconstruction) tighten correctness. Non-blocking for the gate, but resolve U1 in plan first.

## Next Actions
1. (Recommended) Resolve **U1** (idempotency protocol) + I1 + U2 in plan/spec, re-run for clean 0/0/0/0.
2. Commit 010 + snapshot `analyze/010-hermes-executor/v1` (Principle VII).
3. Collect **≥2 external `/speckit.review` PASS** (Principle VI) — emphasize the write-action/cost/isolation surface for reviewers.
4. Then `/speckit.implement` (MVP = US1: gates + T001–T012).
