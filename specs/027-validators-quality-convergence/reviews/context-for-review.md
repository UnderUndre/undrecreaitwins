# Context for Review: 027-validators-quality-convergence

**Feature**: Validators ⊕ Quality Rules — Unified Response Guard Pipeline  
**Status**: Design complete, awaiting external AI review (Principle VI gate)  
**Analyze verdict**: PASS (2 MEDIUM findings, 0 HIGH/CRITICAL)

---

## TL;DR for Reviewers

We're merging **two independent post-processing pipelines** in the engine into **one tiered orchestration module**:

1. **Before**: `ValidatorPipeline.validateResponse()` (4 deterministic validators) + `darExecute()` (LLM-based DAR) — two pipelines, two log models, two configs
2. **After**: Single `responseGuard.run()` — deterministic validators first (cheap), LLM stages after (only on violation), unified log emission

**Why**: Product-028 was trying to normalize these in UI (symptom treatment). We're fixing it at the source (engine level).

**Key innovation**: System validators become **built-in default quality rules** (non-removable, BFF-owned) alongside custom LLM rules. One config, one log, one pipeline.

---

## Critical Context

### 1. Cross-DB Architecture (Non-Negotiable)

**Engine DB** (Postgres + Drizzle):

- `validator_runs` table (engine-internal, deprecated)
- `rule-cache` (in-memory, pushed from BFF)

**BFF DB** (Postgres + Prisma):

- `unified_rules` table (system + custom rules, BFF-owned SOT)
- `quality_events` table (unified log, replaces separate `QualityEvent` + backfilled `validator_runs`)

**Why this matters**: Cross-DB view is **impossible** (two separate Postgres instances, two repos). Solution: validators emit `QualityEventPush` (`kind='system'`) to existing engine→BFF push channel. Normalization happens **once at emitter**, not in UI.

**Review focus**: Verify this doesn't introduce data consistency risks or violate the cross-service boundary pattern established in the architecture.

### 2. Cost Model Preservation (NFR-1 — MUST PASS)

**Requirement**: Happy-path for personas without custom rules must make **zero LLM calls** after 027.

**Mechanism**:

- `terminalOnFail` flag per rule (system + custom)
- Defaults: `block` validators → `true` (stop pipeline), `warn`/`strip`/custom → `false` (continue)
- Deterministic validators run first (no LLM), LLM stages only on violation

**Review focus**: Verify the tiered stage order + short-circuit logic in tasks T008-T011 actually preserves cost parity. Check that `terminalOnFail` defaults are correct and enforced.

### 3. Build-On Path B (Not Fork)

**Decision**: Refactor existing `ValidatorPipeline` into `ResponseGuard` orchestrator. DAR becomes a configurable stage.

**What we're NOT doing**:

- Forking/rewriting chat-service from scratch
- Changing validator algorithms (017/024 preserved as-is)
- Adding new remediation types (translate/regenerate/strip/block from 024 + DAR rewrite from 018 are sufficient)

**Review focus**: Verify tasks T008-T014 actually reuse existing validator classes (`LanguageGuard`, `FalsePromise`, etc.) and DAR pipeline, not rewrite them.

### 4. BFF Ownership of Rule-Store (FR-005)

**Decision**: BFF owns the single source of truth for rules. Engine `validator_configs` becomes cache/projection.

**Flow**:

1. BFF seeds system validators (idempotent upsert on startup)
2. BFF pushes system+custom rules via extended `rules-reload` channel
3. Engine caches in memory (rule-cache)
4. Engine never reads BFF DB directly

**Review focus**: Verify this doesn't create circular dependencies or violate the existing engine↔BFF boundary pattern.

### 5. Verdict Mapping (FR-004)

**Old → New mapping** (happens in engine on emit, NOT in UI):

| Source | Old Verdict | New Verdict | New Detail |
|--------|-------------|-------------|------------|
| `validator_runs` | `passed=false` | `pass` | — |
| `validator_runs` | `passed=true` + `severity='error'` | `block` | — |
| `validator_runs` | `passed=true` + `severity='warn'` | `warn` | — |
| `QualityEvent` | `pass` | `pass` | — |
| `QualityEvent` | `fail` + `rewritten=true` | `corrected` | `rewritten` |
| `QualityEvent` | `fail` + `rolled_back=true` | `block` | `rolled_back` |

**Review focus**: Verify mapping is complete and doesn't lose information. Check that `detail` field captures all native subtypes needed for audit.

---

## What to Review

### Primary Concerns

1. **Constitution compliance** (Principle VI — this gate, Principle IX — two-phase flow)
2. **Requirement coverage** — Do tasks T001-T040 actually implement FR-001 through FR-008 + NFR-1 through NFR-4?
3. **Dependency graph correctness** — No circular deps, no race conditions, proper sync barriers
4. **Agent routing** — Are tasks assigned to correct agents? Do file paths match agent domain?
5. **Regression risk** — Will existing 004/017/018/024 tests pass without modification?

### Secondary Concerns

1. **Backward compatibility** — Can existing `validator_configs` + correction-rule configs be read without manual migration?
2. **Migration safety** — Are `.sql` backfill scripts generated (not executed) per Standing Order 5?
3. **Observability** — Can we verify cost parity (NFR-1) and latency (NFR-2) in production?

### Out of Scope (Explicitly Excluded)

- Product UI changes (028 handles this)
- BFF API endpoint changes (019/026 reused as-is)
- Validator algorithm changes (017/024 preserved)
- New remediation types (existing set is sufficient)

---

## Key Artifacts

| Artifact | Purpose | Key Sections |
|----------|---------|--------------|
| `spec.md` | Feature specification | §3 (User Stories), §4 (Requirements), §Clarifications (critical decisions) |
| `plan.md` | Implementation plan | §Technical Context, §Constitution Check, §Project Structure |
| `research.md` | Codebase analysis + decisions | §2 (Key Technical Decisions), §6 (Implementation Strategy) |
| `data-model.md` | Unified models | §1 (UnifiedRule), §2 (QualityEventPush), §3 (Verdict Mapping) |
| `contracts/quality-event-push.md` | Engine → BFF contract | §2 (Schema), §4 (Verdict Mapping), §5 (Emission Protocol) |
| `contracts/rules-reload.md` | BFF → Engine contract | §2 (Schema), §4 (Push Protocol), §6 (System Validator Seeding) |
| `quickstart.md` | Integration guide | §Step 1 (Engine), §Step 2 (BFF), §Step 4 (Verification) |
| `tasks.md` | Task breakdown | §Phase 1-6, §Dependency Graph, §Agent Dispatch Plan |
| `architecture.md` | Project architecture | §5 (Feature Tracking — 027 entry added) |

---

## Known Issues (from analyze)

**MEDIUM findings** (non-blocking, but should be addressed):

1. **A1**: Feature flag task (T036) in Phase 6 — too late for safe gradual rollout. Recommend moving to Phase 2/3.
2. **A2**: NFR-2 latency verification incomplete — T035 tracks but doesn't verify p95 ≤ max(baseline validateResponse, baseline darExecute).

**LOW findings** (cosmetic/documentation):
3. **A3**: quickstart.md placeholders XXX/YYY/ZZZ for chat-service.ts line numbers (T038 fixes in Phase 6).
4. **A4**: T027/T039 both generate backfill .sql (T039 is conditional, no action needed).

---

## Review Questions

Use these to guide your analysis:

1. **Completeness**: Are there any missing tasks for FR-001 through FR-008?
2. **Consistency**: Do task file paths match the plan.md structure? Are agent tags consistent with file paths?
3. **Dependencies**: Can you trace a path from T001 (types) through to T035 (cost parity) that makes logical sense?
4. **Risks**: What could go wrong during implementation that's not covered by tasks?
5. **Constitution**: Does this violate any principle in `.specify/memory/constitution.md`?

---

## Success Criteria (from spec.md)

Your review should verify that the tasks can achieve:

- **SC-001**: chat-service has ONE guard entry point (grep confirms zero `validateResponse` + zero `darExecute` call-sites)
- **SC-002**: System validators listed as default rules; DELETE attempt rejected; enable/disable/mode work
- **SC-003**: One dialog run with validator + custom rule violation writes both events to unified log format
- **SC-004**: Happy-path personas without custom rules make zero LLM calls in guard
- **SC-005**: Regression suites 004/017/018/024 pass without expectation changes

---

## Constitution Reminders

**Principle VI (Cross-AI Review Gate — NON-NEGOTIABLE)**:

- This IS the gate — your review must be explicit: PASS, MEDIUM, HIGH, or CRITICAL
- Two distinct external reviewers required before `/speckit.implement`
- Override via `--override <reason>` if you have deliberate justification

**Principle VII (Artifact Versioning)**:

- Tags are the only historical record (`plan/027-validators-quality-convergence/v1`, `tasks/027-validators-quality-convergence/v1`)
- No `.history/` files — git is the history

**Principle IX (Two-Phase Review Flow)**:

- Planning in `specs/027-*` (this branch)
- Implementation on `027-*` branch from main (after planning PR merges)

---

## Reviewer Output Format

Please write your review to:

```
specs/027-validators-quality-convergence/reviews/<provider>.md
```

Where `<provider>` is one of: `codex`, `antigravity`, `gemini`, `copilot`

Include a VERDICT block at the end:

```yaml
verdict: PASS | MEDIUM | HIGH | CRITICAL
reviewer: <provider-name>
reviewed_at: <ISO timestamp>
critical_count: <N>
high_count: <N>
medium_count: <N>
low_count: <N>
```

---

## Questions?

If anything is unclear, flag it as a finding. Ambiguity itself is a review finding (MEDIUM severity).

**Remember**: "В системе нет багов, есть только аномалии." — Valera
