# Implementation Plan: Agentic Loop Runtime Readiness

**Branch**: `013-agentic-runtime-readiness` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/013-agentic-runtime-readiness/spec.md`

## Summary

Make spec 010's Hermes agentic loop actually run in a deployed stack by closing two runtime gaps surfaced after the standalone-compose image-namespace fix:

- **US1 (P1)** — Provide the Hermes CLI to the engine runtime: a new engine **container image** (`packages/api/Dockerfile`, Node + Python, `hermes-agent[acp]==0.15.1` via pipx) **and** a documented **host-prereq** path (CQ1), plus a **startup preflight** so a missing/incompatible Hermes fails at boot — not as an opaque `spawn ENOENT` on the first user turn.
- **US2 (P2)** — Rewrite `honcho-client.ts` from the legacy `apps/users` API to **Honcho v3** (`workspaces/peers`, workspace-per-tenant) so working memory actually persists, with **observable degradation** (transient vs permanent mismatch) replacing the current silent no-op.

## Technical Context

**Language/Version**: TypeScript on **Node 20** (engine); **Python 3.12** for the Hermes CLI bundled in-image.
**Primary Dependencies**: `hermes-agent==0.15.1` (`[acp]` extra, installed via pipx); Honcho **v3.0.9** (`ghcr.io/plastic-labs/honcho`); Fastify engine + `buildServer()`; existing `node:child_process` ACP adapter; `pino`.
**Storage**: **No new engine DB entities, no migration.** Honcho v3 (external) holds working memory; Postgres stays the SoR (unchanged).
**Testing**: vitest (unit + integration); a **contract test** against a live honcho v3 instance (field names + `/v3` prefix); a deploy **smoke** (quickstart).
**Target Platform**: Linux **container** (compose) AND **host** process (dev) — both in scope.
**Project Type**: Backend service + container image (infra).
**Performance Goals**: preflight adds < ~2 s to boot; **no per-turn latency regression** (honcho stays off the critical path, fail-open).
**Constraints**: pin exact versions (CQ3); preserve T000d process-per-tenant Hermes isolation; preserve fail-open memory; honcho reconstructible from SoR.
**Scale/Scope**: surgical — 1 new Dockerfile, 1 client rewrite, 1 preflight hook, observability wiring, docs. **Engine-only** (CQ4).

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1.*

This repo **consumes** the upstream `clai-helpers` constitution; Principles **I–V** and **VIII** govern the *template repo* (source-of-truth discipline, transformer-not-fork, clai-helpers SemVer, token economy, self-maintaining `.claude/`) and are **N/A** to a twin-engine runtime feature. Applicable gates:

- **VI — Cross-AI Review Gate (NON-NEGOTIABLE)**: `/speckit.implement` blocks until `reviews/analyze.md` PASS + ≥2 external reviewers PASS. → honored downstream (not this command).
- **VII — Artifact Versioning**: stage tags via `snapshot-stage`. → branch `013-agentic-runtime-readiness` created; **snapshot/commit deferred** pending user consent (Standing Order #1), consistent with spec 010's practice.
- **Standing Orders honored**: no migrations executed (none needed — zero schema change); no secrets in code (honcho/hermes creds via env, `HONCHO_API_KEY` optional); exact version pins (no floating ranges).

**Result**: PASS, 0 violations. Complexity Tracking: empty.

## Project Structure

### Documentation (this feature)

```text
specs/013-agentic-runtime-readiness/
├── plan.md              # This file
├── research.md          # Phase 0 — Honcho v3 mapping, hermes install, preflight, observability
├── data-model.md        # Phase 1 — runtime entities + v3 namespace mapping (no DB)
├── quickstart.md        # Phase 1 — deploy + verify both stories (container + host)
├── contracts/
│   ├── honcho-v3-client.contract.md
│   └── hermes-runtime-preflight.contract.md
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit.tasks)
```

### Source Code (repository root)

```text
packages/api/
├── Dockerfile                         # NEW — engine image: node:20-bookworm-slim + python3 + pipx hermes-agent[acp]==0.15.1
└── src/                               # preflight wired into engine boot / buildServer() readiness

packages/core/src/services/hermes/
├── honcho-client.ts                   # REWRITE — legacy apps/users → Honcho v3 workspaces/peers
└── hermes-preflight.ts                # NEW — `hermes acp --check` + ACP protocolVersion assert at startup

infra/
├── docker-compose.standalone.yml      # engine `build:` already references packages/api/Dockerfile (verify it builds)
└── .env.example                       # HONCHO_API_KEY (optional) — already cleaned of dead HERMES_* in clarify

specs/main/architecture.md             # update: feature 013 row + engine-image (Node+Python) note
```

**Structure Decision**: surgical edits inside the existing `packages/core` hermes service + a new `packages/api/Dockerfile`. **No new package**, no new DB. The two tails are independent (US1 = runtime/image + preflight; US2 = client rewrite), so they parallelise cleanly across `[OPS]` and `[BE]`.

## Complexity Tracking

> No constitution violations — section intentionally empty.
