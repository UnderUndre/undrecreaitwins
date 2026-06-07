# Requirements Quality Checklist — 013-agentic-runtime-readiness

**Stage**: specify + clarify (complete) · **Date**: 2026-06-07

## Content purity
- [x] WHAT/WHY, not HOW — exact v3 endpoint mapping + Dockerfile contents deferred to plan
- [x] No premature lib lock beyond the already-decided Hermes/Honcho substrate (spec 010)

## Completeness
- [x] User stories prioritized (US1 P1 = loop runs at all; US2 P2 = memory works), independently testable, with AC
- [x] FR-001..FR-011 present and testable
- [x] Measurable SC-001..SC-005
- [x] Edge cases enumerated
- [x] Out-of-Scope + Dependencies & Assumptions

## Grounding (verified against code/repo this session)
- [x] No engine Dockerfile exists (`**/Dockerfile*` → none); compose references 4 non-existent Dockerfiles
- [x] Hermes = Python CLI (`hermes_cli`, dev-host venv), spawned `hermes acp` over stdio (hermes-adapter.ts)
- [x] No startup preflight — `spawn` ENOENT surfaces on first turn (hermes-executor.ts:86-95)
- [x] HonchoClient on legacy apps/users API; deployed image v3.0.9; failures swallowed → silent no-op

## Clarifications (resolved — Session 2026-06-07)
- [x] CQ1 → **Both** deployment models: engine container image (`packages/api/Dockerfile`, Node+Python, Hermes on PATH) + documented host-prereq path for dev (FR-004)
- [x] CQ2 → **Disposable/fresh** Honcho store; rebuilt from SoR, no migration (FR-010)
- [x] CQ3 → **Pin exact**: Hermes 0.15.1, Honcho client targets v3.0.9 (FR-011)
- [x] CQ4 → **Engine + memory only**; worker/channel Dockerfiles = separate feature (scope boundary)

## Known flags / risks (carried to plan)
- [ ] Honcho v3 namespace = workspaces/peers ASSUMED (~0.8) — confirm in research before client rewrite
- [ ] Per-tenant isolation must hold in v3 model (spec 010 T000b open) — verify
- [ ] Hermes process-per-tenant isolation (spec 010 T000d leak) MUST NOT regress
- [ ] Distinguish transient Honcho outage (degrade) from permanent API mismatch (must be loud)

## Gate
- Specify + Clarify: **PASS**, 0 open clarifications. Ready for `/speckit.full-plan`.
- Versioning (VII): branch created (`013-agentic-runtime-readiness`); snapshot/commit deferred (no commit without consent).
