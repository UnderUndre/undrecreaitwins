# Requirements Quality Checklist — 010-hermes-executor

**Stage**: specify (+ clarify in progress) · **Date**: 2026-06-03

## Content purity
- [x] WHAT/WHY, not HOW — Hermes internals + deployment deferred to plan/C3
- [x] No premature lib lock beyond the decided Hermes/Honcho substrate

## Completeness
- [x] User stories prioritized (US1/US2 P1, US3/US4 P2), independently testable, with AC
- [x] FR-001..FR-012 present and testable
- [x] Measurable SC-001..SC-005
- [x] Edge cases enumerated
- [x] Glossary + Out-of-Scope + Dependencies
- [x] Cross-feature boundary defined (DD-HX-001)

## Brainstorm decisions captured
- [x] Topology C (hybrid routing)
- [x] Memory: Honcho working + engine Postgres SoR; Letta dropped (FR-004)
- [x] Lifecycle: spawn-on-demand + hibernate + warm-pool; engine-cron heartbeat (FR-005/006)
- [x] Mandatory guardrails as FR/NFR: validators-gate (FR-003), tool-sandbox (FR-007), metering (FR-008), fallback (FR-009)

## Clarifications (resolved — Session 2026-06-03)
- [x] C1 → real write-actions in v1 (permission + audit + idempotency + validator gate)
- [x] C2 → always-agent (scripted → deterministic; else Hermes; completion = fallback-only)
- [x] C3 → self-host hermes-agent (OSS)

## Known flags / risks (carried to plan)
- [ ] `hermes-agent` OSS license for self-hosted multi-tenant use — VERIFY (resale-embed concern moot via self-host)
- [ ] Honcho per-tenant namespace isolation — confirm
- [ ] **Cost/latency CRITICAL** (always-agent): hard loop/token cap + per-tenant budget + warm-pool mandatory v1 (FR-008, NFR cost/latency)
- [ ] **Write-action blast radius** (C1): wrong external write → permission + dry-run/confirm (high-stakes) + audit + idempotency
- [ ] Agent loops vs 002 abort / 009 idempotency over multi-step side-effects

## Gate
- Specify + Clarify: PASS, 0 open clarifications. Ready for /speckit.full-plan.
- Versioning (VII): branch/snapshot deferred (no commit without consent).
