# Implementation Plan: Language Response Guard

**Branch**: `feature/017-language-guard-validator` | **Date**: 2026-06-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/017-language-guard-validator/spec.md`

## Summary

Add a deterministic `language-guard` response validator to the existing 004-validators pipeline. The guard inspects every AI response for Unicode scripts outside a per-persona allowlist (`allowedLanguages`), strips low-level contamination or blocks heavily-contaminated responses, and injects a proactive language directive into the system prompt to reduce violations at the source. No ML inference — pure Unicode code-point range analysis. Zero LLM calls on the happy path.

## Technical Context

**Language/Version**: TypeScript (Node.js 20)
**Primary Dependencies**: Drizzle ORM, Zod, existing `ValidatorPipeline` / `ResponseValidator` interface
**Storage**: PostgreSQL — reuses `validator_configs` and `validator_runs` tables (no new tables)
**Testing**: Vitest (Unit & Integration)
**Target Platform**: Node server — `packages/core` only (no `packages/api` surface; config via existing validator API/seed)
**Project Type**: Web service / Core library addition
**Performance Goals**: ≤5ms per response on happy path (SC-002); zero additional LLM calls when response fully passes (SC-003 / FR-011)
**Constraints**: Must fit into existing `ValidatorPipeline` interface; must not break existing validators; deterministic only (no ML)
**Scale/Scope**: Per-(tenant, persona) configuration; runs on every non-streaming response for configured personas

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Source of Truth | PASS | App-code feature (`packages/core`); no `.claude/` or generated-file edits |
| II. Transformer, Not Fork | N/A | No AI-tool target changes |
| III. Protected Slots | N/A | No managed/generated files touched |
| IV. SemVer 0.x | N/A | No package version bump in this branch |
| V. Token Economy | PASS | One new validator file + one config type extension; reuses existing pipeline; no new agents/skills |
| VI. Cross-AI Review Gate | PENDING | `analyze.md` + ≥2 external reviews required before `/speckit.implement` |
| VII. Artifact Versioning | PASS | Tags created via `snapshot-stage.ps1` on commit |
| VIII. Self-Maintaining | PASS | Unicode-script-detection pattern is a `/learn` candidate post-ship |
| WRAP atomicity | PASS | Single-validator addition; <300 LOC expected |

**Gate**: PASS on all design principles. VI/VII are process gates handled at review/commit time.

## Project Structure

### Documentation (this feature)

```text
specs/017-language-guard-validator/
├── spec.md              # Feature specification (existing)
├── checklists/
│   └── requirements.md  # Requirements checklist (existing)
├── plan.md              # This file
├── research.md          # Phase 0: Unicode script detection analysis
├── quickstart.md        # Phase 1: Validation guide
└── tasks.md             # Phase 2: Task breakdown
```

### Source Code (repository root)

```text
packages/core/src/
├── services/
│   ├── chat-service.ts                          # MODIFY: language directive injection in buildSystemPrompt
│   └── validators/
│       ├── pipeline.ts                          # MODIFY: register language-guard, add to responseValidators
│       └── language-guard.ts                    # NEW: Language guard validator implementation
├── types/
│   └── validator.ts                             # MODIFY: add LanguageGuardConfig, extend AnyValidatorConfig
└── models/
    └── validators.ts                            # MODIFY: add 'strip' to validatorVerdictEnum if missing

packages/core/src/test/
└── validators/
    └── language-guard.test.ts                   # NEW: Unit tests

drizzle/
└── 000x_add_language_guard_strip_verdict.sql    # NEW: Migration if 'strip' verdict not in enum
```

**Structure Decision**: Language guard follows the identical pattern established by `false-promise.ts`, `format-injection.ts`, and `identity-guard.ts`. No structural innovation — pure extension.

## Design Decisions

### DD-001: Unicode Script Detection via Code-Point Ranges

**Decision**: Implement a `ScriptClassifier` that maps each character's Unicode code point to a script name (Cyrillic, Latin, Han, Arabic, etc.) using a static range table. No external dependencies. No ML.

**Rationale**: Spec assumption: "Language/script detection is deterministic (Unicode code-point range analysis); no ML inference is used." A static table of ~20 Unicode ranges covers all major scripts. Performance: O(n) scan of the response string, single pass, no regex backtracking. Each character classified into exactly one script or "common" (punctuation, digits, control chars). "Common" characters are always excluded from the non-compliant fraction.

**Ranges** (initial set, extensible):
- Latin: U+0000–U+024F (basic + extended) **+ U+1E00–U+1EFF (Latin Extended Additional — Vietnamese diacritics, claude F8)**. Known limitation: further extended-Latin blocks (C/D) are not covered in MVP; `ScriptClassifier` table is designed extensible — document in a code comment.
- Cyrillic: U+0400–U+04FF + U+0500–U+052F
- Han (CJK): U+4E00–U+9FFF + U+3400–U+4DBF
- Arabic: U+0600–U+06FF
- Devanagari: U+0900–U+097F
- Hebrew: U+0590–U+05FF
- Thai: U+0E00–U+0E7F
- Korean (Hangul): U+AC00–U+D7AF + U+1100–U+11FF
- Katakana: U+30A0–U+30FF
- Hiragana: U+3040–U+309F

**Language → Script mapping**: `allowedLanguages` uses BCP-47 language codes (e.g., `"ru"`, `"en"`, `"zh"`). A static lookup maps each code to one or more permitted scripts:
- `"ru"` → `[Cyrillic]`
- `"en"` → `[Latin]`
- `"zh"` → `[Han]`
- `"ar"` → `[Arabic]`
- `"ja"` → `[Hiragana, Katakana, Han, Latin]`
- `"ko"` → `[Hangul, Han, Latin]`

**Why `"zh"` stays `[Han]` (no Latin)** — claude F5 raised that Chinese text routinely contains URLs/emails in Latin. Remedy is **masking (DD-008)**, not adding Latin to the mapping: blanket-allowing Latin would let a fully-English response pass a Chinese-only persona, defeating the guard's primary purpose. `ja`/`ko` keep Latin for linguistic reasons (romaji/loanwords), `zh`/`ar`/`he` rely on DD-008 masking for URLs/emails.

### DD-002: `strip` vs `block` Threshold Model

**Decision**: Two thresholds: `stripThreshold` (default 0.05) and `blockThreshold` (default 0.30). If non-compliant fraction < `stripThreshold` → `pass` (noise floor). If ≥ `stripThreshold` and < `blockThreshold` → `strip` (remove non-compliant characters). If ≥ `blockThreshold` → `block` (replace entire response with fallback).

**Rationale**: Per spec FR-004/FR-005/FR-006. The `stripThreshold` absorbs incidental cross-script content (proper names); code/URLs/emails are masked outright (DD-008). `blockThreshold` catches wholesale language contamination. Configuration validation enforces `stripThreshold ≤ blockThreshold` (FR-006).

**Formula (FR-015, gemini F3 / claude F2)**: `nonCompliantFraction = nonCompliantScriptChars / scriptChars`, where `scriptChars = totalChars − commonChars − maskedChars`. Common = punctuation, whitespace, digits, emoji, control. Denominator 0 → fraction 0 → `pass`. Pinning the denominator to *classified script chars* (not raw length) makes thresholds behave intuitively: 60% whitespace + 30% Russian + 10% Chinese → fraction 25%, not 10%.

**Strip quality (gemini F4 / claude F4)**: stripping removes characters mid-sentence; above ~15% contamination the output degrades into stitched words. Documented in spec Edge Cases; default `dry-run` mode is the calibration window. A `stripMaxFraction` promote-to-block cap is noted as a follow-up knob — NOT in MVP (avoids a third threshold to mis-tune).

### DD-003: Language Directive Injection in `buildSystemPrompt`

**Decision**: When `allowedLanguages` is non-empty, append a language constraint clause to the system prompt parts in `ChatService.buildSystemPrompt()`. The directive reads: `"IMPORTANT: You must respond ONLY in [language names]. Do not use any other language or script."`

**Single config resolution (gemini F2/F5, claude F3)**: the language-guard config is resolved **once per request** at the chat-lifecycle entry (`ChatService.complete()`), where `tenantId` is already in scope, and the resolved config is passed to both `buildSystemPrompt()` (directive) and the validator pipeline (evaluation) — e.g. via an optional `preloadedConfigs` param on `validateResponse` / a request-scoped holder. No second DB read for the same `(tenant, persona, 'language-guard')` row per turn; no extra join to recover `tenantId` inside `buildSystemPrompt`.

**Rationale**: Per US3 / FR-002 — proactive violation reduction. Injection point is `buildSystemPrompt`, which already assembles persona prompt + traits + annotation few-shot. Language directive is appended last (lowest priority override). When `allowedLanguages` is empty, no directive is added (FR-012).

**Error handling**: The config query in `buildSystemPrompt` must fail-open — if the DB read throws or times out, the directive is silently skipped and the response proceeds without it. This matches the existing annotation-retrieval pattern (lines 593–595: catch + `console.warn` + proceed). A missing directive does not break the chat path; the post-generation language guard still catches violations.

### DD-004: Config Storage in Existing `validator_configs` Table

**Decision**: Language guard config lives in `validator_configs` with `validatorName: 'language-guard'`. The `config` JSONB column holds `LanguageGuardConfig`. No new tables.

**Rationale**: Per spec assumption: "The configuration is stored in the existing per-persona validator config store (no new database table required), using `validatorName: 'language-guard'` as the key." The existing table's unique index on `(tenant_id, persona_id, validator_name)` already enforces one config per persona per validator.

### DD-005: No-Op When `allowedLanguages` is Empty

**Decision**: When `allowedLanguages` is empty/absent, the validator's `validateAndMutate` returns `pass` immediately with `decision: 'pass'` and no audit entry. The directive injection is also skipped.

**Rationale**: Per FR-012: "When `allowedLanguages` is empty or absent, the guard MUST be a complete no-op — no directive injection, no validation, no audit entry." Implementation: check `allowedLanguages` length at the top of `validateAndMutate`; if 0, return `{ verdict: { decision: 'pass' }, mutatedText: reply, latencyMs: 0 }`. The pipeline will still call `persistRuns`, but we can handle this by checking `decision !== 'pass'` before persisting, or by having the pipeline skip `pass` results for this validator.

**Implementation** *(explicit pipeline-level convention — claude F6, option 3)*: The no-op check lives **inside** `LanguageGuardValidator.validateAndMutate()` — no interface change. When `allowedLanguages` is empty, the method returns `{ verdict: { decision: 'pass' }, mutatedText: reply, latencyMs: 0 }` immediately. The pipeline persists this `pass` like any other validator's `pass`. When `allowedLanguages` is non-empty and the response is clean, the `pass` verdict IS persisted (FR-009: all evaluation events are audited). The distinction is: empty config → validator doesn't evaluate at all (no event), non-empty config + clean response → validator evaluates and records `pass`. To achieve "no audit entry on empty config", the pipeline skips persistence for language-guard when `config.allowedLanguages` is empty — a single `if` check in the pipeline's per-validator loop, no new method on the interface.

### DD-006: Default Mode is `dry-run`

**Decision**: Default `mode` for language-guard is `dry-run` (matching the identity-guard pattern from 004). Operators must explicitly promote to `active`.

**Rationale**: Per FR-008: "The default `mode` for new language guard configurations MUST be `dry-run`." This follows the same safe-defaults pattern as identity-guard — a new validator shouldn't start mutating responses without explicit operator opt-in. The `resolveConfig` default path in `pipeline.ts` will handle this.

### DD-007: `regenerateOnViolation` — Deferred to Follow-up

**Decision**: `regenerateOnViolation` is **deferred from MVP**. The pipeline API change required (passing a generation callback into `validateResponse`) is the most invasive change in the task list and affects the interface used by all validators. For MVP, the flag is accepted in config but ignored — `block` verdict always delivers the fallback message. A follow-up spec (`specs/017-language-guard-validator/followup-regenerate.md`) will handle the pipeline extension.

**Rationale**: Per FR-010 and edge case: "Retry also violates (`regenerateOnViolation: true`): The same strip/block logic is applied to the retry result. No further retries are attempted." The semantics are clear; the implementation cost is disproportionate for an initial delivery. Config field exists (boolean, default `false`) so the schema is forward-compatible — no migration needed when the feature is activated.

### DD-008: Code/URL/Email Masking Before Classification (gemini F1, claude F1/F5)

**Decision**: Before script classification, `ScriptClassifier.analyze()` receives the response text with the following spans **masked** (replaced by a neutral placeholder excluded from both numerator and denominator): markdown fenced code blocks (`/```[\s\S]*?```/g`), inline code spans (`` /`[^`\n]+`/g ``), URLs (`/https?:\/\/\S+/g`), and email addresses. Deterministic regex — no parser dependency.

**Rationale**: Without this, the feature is broken for technical personas: a Russian developer bot emitting a 30-line Python block (~80% Latin) exceeds `blockThreshold: 0.30` and the legitimate response is replaced with the fallback. Same class of failure for URLs in strict-script personas (`zh`/`ar`/`he`). Masking is the targeted fix; blanket-allowing Latin would gut the guard (see DD-001). Failure mode of the simple regex on malformed fences = a span counts as regular text → slightly higher fraction; no data loss (acceptable for MVP per claude's own alternatives analysis).

## Complexity Tracking

> No constitution violations. The feature is a pure extension of the existing validator pipeline.
