# SpecKit Analyze: 013-agentic-runtime-readiness

**Reviewer**: analyze (Claude self-consistency)
**Reviewed at**: 2026-06-07T17:15:45+03:00
**Commit**: 9ba3c0c01acaec9317ef0636291684b2570c7545 *(artifacts modified in working tree — review-remediation uncommitted)*
**Artifacts**: spec.md, plan.md, tasks.md, research.md, data-model.md, contracts/{honcho-v3-client,hermes-runtime-preflight}.contract.md, quickstart.md, checklists/requirements.md
**Run**: 2nd pass — after `/fix_from_review` folded in codex + gemini findings (US3 added, Dockerfile reframed, preflight/honcho hardened).

## Summary

The **content** is now clean: all 10 external-review findings (codex F1/F3–F7, gemini F1–F5) and the 2 MEDIUMs from the 1st analyze pass are resolved in the artifacts. US3 (live-path wiring) closes the headline gap; the Dockerfile is correctly reframed "convert existing"; preflight (timeout + shared parser + enablement) and the honcho client (cache + 409 + pinned health field) are specified. **One blocker remains and it is non-negotiable**: Principle VII stage snapshots are absent — only `review/013/v1` exists; no `specify|clarify|plan|tasks/013/v*` tags. Per constitution authority this is CRITICAL. It is also a 1-step fix (commit remediated artifacts → `snapshot-stage` per stage).

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| K1 | Constitution (VII) | **CRITICAL** | git tags; plan.md Constitution Check | Stages specify/clarify/plan/tasks are **not tagged** (`snapshot-stage`); only `review/013/v1` exists. Principle VII MUST ("every stage tags the commit") unmet. Compounded: artifacts are now modified-uncommitted, so a correct tag needs a fresh commit first. | **Commit** the remediated artifacts (user consent — Standing Order #1), then run `snapshot-stage -Stage {specify,clarify,plan,tasks}` (idempotent). Flips this to resolved. Sole gate blocker. |
| C1 | Coverage | MEDIUM | spec FR-009; tasks T010/T013 | SoR-reconstructability invariant still has **no dedicated verification task** — relies on T010 preserving 010's hydration + T013's isolation review. | Add an explicit reconstructability round-trip check to T013 (or a small `[E2E]` sub-task). Carried from pass 1. |
| X1 | Inconsistency | LOW | remediation labels across artifacts | Review-remediation entries are dated **2026-06-08** while HEAD/clock is **2026-06-07** (TZ skew vs the review bundle). Cosmetic. | Align the date label, or leave (harmless provenance note). |
| X2 | Cross-feature | LOW | spec US3/FR-015; specs/main + 010 | US3 (ChatService→runAgentTurn wiring) is **010's unfinished work**, now owned by 013 (decided). Risk: 010 and 013 both claim it later. | Add a one-line pointer in 010's spec / architecture.md noting the wiring lives in 013. |
| X3 | Risk (informational) | LOW | tasks T015; chat-service.ts | `chat-service.ts` is a central, high-blast-radius file; only T015 touches it (no cross-agent race), but the wiring must be **additive** (preserve thin-completion fallback + 003 determinism). | Keep T015 additive; T016 asserts scripted turns unaffected (already specified). |

## Coverage Summary

| Requirement | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-001..004 (runtime/image/preflight) | yes | T004, T005, T006, T007, T003 | Dockerfile convert + preflight |
| FR-005 (honcho v3 API) | yes | T010, T008 | rewrite + contract test |
| FR-006/007 (degrade + observable) | yes | T011, T009 | pinned health field |
| FR-008 (isolation) | yes | T010, T009, T013 | workspace-per-tenant |
| FR-009 (SoR reconstructable) | indirect | (T010 preserve, T013) | C1 |
| FR-010 (no migration) | n/a | (T001 fresh) | satisfied by no-work |
| FR-011 (pin versions) | yes | T001, T004 | — |
| FR-012 (enablement predicate) | yes | T001, T006, T003 | `AGENTIC_EXECUTOR_ENABLED` |
| FR-013 (cache + 409) | yes | T010, T009 | no N+1 |
| FR-014 (preflight timeout/parser) | yes | T005, T006 | 5 s + acp-command.ts |
| FR-015 (live-path wiring) | yes | T015, T016 | US3 |
| SC-001..005 | yes | T003, T008, T009, T014, T016 | all mapped |

## Constitution Alignment Issues

- **Principle VII (Artifact Versioning)** — **VIOLATED (K1)**: stage snapshots missing. Resolution: commit + `snapshot-stage`.
- **Principle VI (Cross-AI Review Gate)** — in progress: analyze (this) + 2 external reviews exist but both were **CRITICAL pre-remediation**; they MUST be re-run to reach ≥2 PASS before `/speckit.implement`.
- Principles I–V, VIII — govern the upstream template; N/A to this runtime feature.

## Unmapped Tasks

None. All 16 tasks (T001–T016) map to a requirement, success criterion, or setup/polish role.

## Metrics

- Total Requirements: 15 functional (+ 5 success criteria)
- Total Tasks: 16
- Coverage % (FR with ≥1 task): **93%** direct (14/15); FR-009 indirect, FR-010 intentionally taskless → effectively 100% addressed
- Ambiguity count: 0 (pass-1 U1/A1 resolved — health field + timeout pinned)
- Duplication count: 0
- CRITICAL count: 1
- HIGH count: 0
- MEDIUM count: 1
- LOW count: 3

## VERDICT

```yaml
verdict: CRITICAL
reviewer: analyze
reviewed_at: 2026-06-07T17:15:45+03:00
commit: 9ba3c0c01acaec9317ef0636291684b2570c7545
critical_count: 1
high_count: 0
medium_count: 1
low_count: 3
blocker: "Principle VII stage snapshots missing — commit remediated artifacts + snapshot-stage to clear (content otherwise PASS-clean)"
```
