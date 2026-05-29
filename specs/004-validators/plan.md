# Implementation Plan: Response & Input Validators (Phase 1)

**Branch**: `004-validators` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-validators/spec.md`

## Summary

Port the legacy validator subsystem into the engine as a composable pipeline that inspects outbound replies and inbound messages, remediating unsafe content before delivery. This phase implements the `false-promise`, `format-injection`, and `identity-and-provider-guard` validators, adding per-tenant/persona configuration (`active` vs `dry-run`) and database persistence for audit logs.

## Technical Context

**Language/Version**: TypeScript (Node.js)
**Primary Dependencies**: Drizzle ORM, Zod, existing LLM client (to be extracted/shared)
**Storage**: PostgreSQL
**Testing**: Vitest (Unit & Integration)
**Target Platform**: Node server (`packages/core` and `packages/api`)
**Project Type**: Web service / Core library
**Performance Goals**: <10ms added p95 latency for clean inputs/replies; max 1500ms when LLM judge invoked.
**Constraints**: Must compose cleanly with `003-script-funnels` generation hooks; no blocking the chat path indefinitely on failures.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] No `NEEDS CLARIFICATION` remaining for Phase 1 targets.
- [x] Artifacts versioned (using tags in Phase 1 snapshot).
- [x] Meets atomicity and source-of-truth guidelines.

## Project Structure

### Documentation (this feature)

```text
specs/004-validators/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Interfaces and types
│   └── validator.ts
└── tasks.md             # Phase 2 output
```

### Source Code (repository root)

```text
packages/core/src/
├── db.ts                # Drizzle schema (adding configs and runs)
├── services/
│   ├── chat-service.ts  # Generates hook points
│   ├── llm-client.ts    # Extracted shared LLM client
│   └── validators/
│       ├── pipeline.ts               # Orchestrator
│       ├── false-promise.ts          # False promise validator
│       ├── format-injection.ts       # Format injection strip
│       └── identity-guard.ts         # Identity & provider guard
└── types/
    └── validator.ts     # Internal DTOs and types
```

**Structure Decision**: The validator logic belongs in `packages/core/src/services/validators`. The shared LLM client extraction will live at `packages/core/src/services/llm-client.ts` to be shared between this feature and `003-script-funnels`. Database additions go into the existing Drizzle definitions in `packages/core/src/db.ts`. `identity-and-provider-guard` will be implemented as a deterministic regex-based validator.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| N/A       | N/A        | N/A                                 |
