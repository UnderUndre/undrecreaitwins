# SpecKit Analyze: 013-agentic-runtime-readiness

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-07T12:10:34-07:00
**Commit**: 6b45c5cb72488ca369b0ef8c164c397dc3d9b67d
**Artifacts**: spec.md, plan.md, tasks.md, research.md, data-model.md, contracts/{honcho-v3-client,hermes-runtime-preflight}.contract.md, quickstart.md

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| C1 | Coverage | MEDIUM | spec FR-009; tasks T010/T013 | SoR-reconstructability invariant ("Honcho MUST remain reconstructible from SoR") has **no dedicated verification task**; relies implicitly on T010 preserving the existing 010 hydration/reconstruction logic. | Add an explicit acceptance note to T010 (preserve hydrate + SoR→Honcho seed against v3) and a round-trip check in T013, or a small `[E2E]` sub-task. |
| U1 | Underspecification | MEDIUM | spec FR-007; data-model "Memory Health Signal"; tasks T011 | Observability primitive left as "metric **and/or** health/readiness indicator" — not pinned. Repo has both Langfuse and `/v1/health`. | Pick one concrete mechanism in impl (recommend readiness/health field + structured pino log + a `honcho_degraded` counter). |
| C2 | Coverage | LOW | spec FR-010; tasks T001 | "No migration" (disposable/fresh) is satisfied by **absence of work** — no guard task ensures migration code isn't added. | Note in T001/T010: explicitly assert no data-migration path is introduced. |
| G1 | Agent Routing | LOW | tasks Dependencies `T008 → T010` | `[E2E]` contract test (T008) precedes impl (T010) — technically an inversion per routing rule G ("[E2E] must depend on impl"). | **Intentional TDD RED-first**, explicitly sanctioned by tasks-template ("write tests FIRST, ensure they FAIL"). Keep; flagged for transparency only. |
| I1 | Inconsistency | LOW | plan Technical Context vs tasks T004 | plan claims "Python **3.12**"; `node:20-bookworm-slim` ships Debian 12 → Python **3.11**. | Fix the claim to 3.11 (pipx + hermes-agent work regardless of 3.11/3.12); or add deadsnakes if 3.12 is truly required. |
| K1 | Constitution | LOW | plan Constitution Check; Principle VII | Stage snapshots (`spec/clarify/plan/tasks/013/v*`) **not yet created** — deferred pending commit (Standing Order #1). | Expected pre-commit; tag via `snapshot-stage` once the artifacts are committed, before `/speckit.implement`. Not a violation — a not-yet-reached step. |
| U2 | Underspecification | LOW | research §b/§f; tasks T010/T004 | Two research open-items (honcho v3 self-host auth default; whether the `[acp]` extra needs Node at runtime) are folded into tasks but not called out as explicit acceptance checks. | Add verify-notes to T010 (auth default → `HONCHO_API_KEY`) and T004 (acp extra runtime deps). |
| A1 | Ambiguity | LOW | hermes-runtime-preflight.contract.md; plan | Unquantified terms: preflight "short timeout", image "lean". | Quantify in impl (e.g. preflight `hermes acp --check` timeout = 5s). |

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|-----------------|-----------|----------|-------|
| fr-001-hermes-resolvable | yes | T004 | engine image installs hermes on PATH |
| fr-002-acp-compatible | yes | T004, T005 | build-time `acp --check` + runtime protocolVersion assert |
| fr-003-startup-preflight | yes | T005, T006, T003 | impl + wire + integration |
| fr-004-both-deploy-models | yes | T004 (container), T007 (host) | CQ1 |
| fr-005-honcho-v3-api | yes | T010, T008, T001 | rewrite + contract test |
| fr-006-graceful-degrade | yes | T011, T009 | fail-open preserved |
| fr-007-observable-degradation | yes | T011 | primitive underspecified (U1) |
| fr-008-per-tenant-isolation | yes | T010, T009, T013 | workspace-per-tenant |
| fr-009-sor-reconstructable | **indirect** | (T010 preserve) | no dedicated task (C1) |
| fr-010-no-migration | n/a | (T001 fresh) | satisfied by no-work (C2) |
| fr-011-pin-exact-versions | yes | T001, T004 | CQ3 |
| sc-001..005 | yes | T003, T008, T009, T014 | success criteria all mapped |

## Constitution Alignment Issues

- **Principle VI (Cross-AI Review Gate)** — not violated; this `analyze` IS the first gate. ≥2 external `/speckit.review` PASS still required before `/speckit.implement`.
- **Principle VII (Artifact Versioning)** — snapshots deferred pre-commit (K1). Not a violation; tag on commit.
- Principles I–V, VIII govern the upstream `clai-helpers` template, **N/A** to this consumer-repo runtime feature (noted in plan.md). No conflicts.

## Unmapped Tasks

None. All 14 tasks (T001–T014) map to a requirement, success criterion, or a supporting setup/polish role.

## Metrics

- Total Requirements: 11 functional (+ 5 success criteria)
- Total Tasks: 14
- Coverage % (FR with ≥1 task): **91%** direct (10/11); FR-009 indirect, FR-010 intentionally taskless → effectively 100% addressed
- Ambiguity count: 2 (U1, A1)
- Duplication count: 0
- CRITICAL count: 0
- HIGH count: 0
- MEDIUM count: 2
- LOW count: 6

## VERDICT

```yaml
verdict: PASS
reviewer: analyze
reviewed_at: 2026-06-07T12:10:34-07:00
commit: 6b45c5cb72488ca369b0ef8c164c397dc3d9b67d
critical_count: 0
high_count: 0
medium_count: 2
low_count: 6
```
