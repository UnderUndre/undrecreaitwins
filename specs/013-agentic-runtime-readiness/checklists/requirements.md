# Requirements Quality Checklist — 013-agentic-runtime-readiness

**Stage**: specify + clarify (complete) · **Date**: 2026-06-07

## Content purity
- [x] WHAT/WHY, not HOW — exact v3 endpoint mapping + Dockerfile contents deferred to plan
- [x] No premature lib lock beyond the already-decided Hermes/Honcho substrate (spec 010)

## Completeness
- [x] User stories prioritized (US1 P1 = runtime+preflight; US2 P2 = memory; US3 P1 = live-path wiring — review-added), independently testable, with AC
- [x] FR-001..FR-015 present and testable (FR-012..015 added in review remediation)
- [x] Measurable SC-001..SC-005
- [x] Edge cases enumerated
- [x] Out-of-Scope + Dependencies & Assumptions

## Grounding (verified against code/repo this session)
- [x] Engine Dockerfile **exists** (`packages/api/Dockerfile`, `node:20-alpine`, Node-only) — needs **conversion** to Node+Python+Hermes (corrected after review — codex F3; earlier glob predated commit `9ba3c0c`)
- [x] Hermes = Python CLI (`hermes_cli`, dev-host venv), spawned `hermes acp` over stdio (hermes-adapter.ts)
- [x] No startup preflight — `spawn` ENOENT surfaces on first turn (hermes-executor.ts:86-95)
- [x] HonchoClient on legacy apps/users API; deployed image v3.0.9; failures swallowed → silent no-op

## Clarifications (resolved — Session 2026-06-07)
- [x] CQ1 → **Both** deployment models: engine container image (`packages/api/Dockerfile`, Node+Python, Hermes on PATH) + documented host-prereq path for dev (FR-004)
- [x] CQ2 → **Disposable/fresh** Honcho store; rebuilt from SoR, no migration (FR-010)
- [x] CQ3 → **Pin exact**: Hermes 0.15.1, Honcho client targets v3.0.9 (FR-011)
- [x] CQ4 → **Engine + memory only**; worker/channel Dockerfiles = separate feature (scope boundary)

## Known flags / risks (carried to plan)
- [x] Honcho v3 namespace = workspaces/peers **CONFIRMED** (research §a, ~0.95); field names verified via T008 contract test
- [ ] Per-tenant isolation must hold in v3 model (spec 010 T000b open) — verify
- [ ] Hermes process-per-tenant isolation (spec 010 T000d leak) MUST NOT regress
- [ ] Distinguish transient Honcho outage (degrade) from permanent API mismatch (must be loud)

## Review remediation (2026-06-08 — codex + gemini)
- [x] codex F1 → US3 + FR-015 (live-path wiring) added; SC-001 narrowed
- [x] codex F3 → Dockerfile reframed "convert existing", not "NEW"
- [x] codex F4 → `AGENTIC_EXECUTOR_ENABLED` predicate (FR-012) + test matrix (T003)
- [x] codex F5 → permanent-mismatch RED test (T008) + pinned health field
- [x] codex F6 → shared `acp-command.ts` parser (T005/T006)
- [x] codex F7 + gemini F4/F5 → resolved-ID cache + 409→GET (FR-013, T010/T009)
- [x] gemini F1 → preflight 5 s timeout (FR-014, T005)
- [x] gemini F2 → Python 3.11 / alpine→bookworm-slim
- [x] gemini F3 → `PIPX_BIN_DIR=/usr/local/bin`
- [ ] codex F2 → Principle VII stage snapshots — **pending commit** (Standing Order #1; offer to run)

## Gate
- Specify + Clarify: **PASS**, 0 open clarifications.
- Review remediation: 9/10 findings folded into artifacts; F2 (snapshots) pending commit. Re-run `/speckit.analyze` + external re-review recommended before `/speckit.implement`.
- Versioning (VII): branch created (`013-agentic-runtime-readiness`); snapshot/commit deferred (no commit without consent).
