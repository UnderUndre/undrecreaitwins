# Implementation Plan: Engine Funnel Richness

**Branch**: `020-engine-funnel-richness` | **Date**: 2026-06-18 | **Spec**: [specs/020-engine-funnel-richness/spec.md](spec.md)
**Input**: Feature specification for Engine Funnel Richness — Cascade, Modes, Variables, Humanization.

## Summary

Enhance the `undrecreaitwins` funnel runtime with advanced features from the original 017 design: delivery cascade (verbatim/template/llm), variable substitution, adaptive intro, structured slot extraction, human-like pacing, and anytime stages. This ensures the bot can guarantee literal delivery when needed while remaining flexible and "human-like" in free-form parts.

## Technical Context

**Language/Version**: TypeScript (Node.js 20)
**Primary Dependencies**: Drizzle ORM, ioredis, LLMClient (existing core), `@undrecreaitwins/shared`
**Storage**: PostgreSQL (via Drizzle), Redis (locks/cache)
**Testing**: Vitest (Unit + E2E)
**Target Platform**: Node.js Engine service
**Project Type**: Backend service core extension
**Performance Goals**: Verbatim p95 < 50ms, Template p95 < 50ms, Intro p95 < 1s
**Constraints**: Sync extraction post-turn, global cap on reruns (max 2), no DSPy, no external memory platforms.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|-----------|-------|--------|
| I. Source of Truth | Shared types update in `packages/shared`. | ✓ PASS |
| II. Transformer | N/A (Core logic) | ✓ PASS |
| III. Protected Slots | N/A | ✓ PASS |
| IV. SemVer | Feature addition (Engine-side) | ✓ PASS |
| VI. Cross-AI Review | Mandatory before implement | ⚠ PENDING |
| VII. Artifact Versioning | Tags will be created | ✓ PASS |

## Project Structure

### Documentation (this feature)

```text
specs/020-engine-funnel-richness/
├── plan.md              # This file
├── research.md          # Implementation details & research
├── data-model.md        # Database schema extensions
├── quickstart.md        # How to use new funnel features
├── contracts/           # API and Metadata contracts
└── tasks.md             # Task breakdown
```

### Source Code (repository root)

```text
packages/core/
├── src/
│   ├── models/          # Updated Drizzle schemas
│   └── services/
│       ├── funnel/      # Extended FunnelRuntime & Scorer
│       └── llm/         # New SlotExtractor & Humanizer services
packages/shared/
└── src/
    └── types.ts         # Updated shared interfaces
```

**Structure Decision**: Extending existing `packages/core` funnel services and adding new specialized services for extraction and humanization to keep `FunnelRuntime` manageable.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Multi-stage LLM pipeline | Required for adaptive intro + anti-repeat | Single prompt would be too complex/unreliable |
| Sync post-turn extraction | Required for guards on next turn | Async worker would introduce race conditions for requiredSlots |
