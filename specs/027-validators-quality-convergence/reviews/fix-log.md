# Fix Log: Review claude.md Fixes Applied

**Date**: 2026-06-23
**Reviewer**: claude (CRITICAL verdict, 5 CRITICAL, 4 HIGH, 3 MEDIUM, 3 LOW)
**Decision**: All 15 findings agreed. Fixes applied to design docs.

## Files Modified (7)

| File | Findings Fixed |
|------|----------------|
| `data-model.md` | F1 (verdict mapping from real columns), F2 (detector/rewriteInstruction in UnifiedRule), F5 (composite @@id), F6 (format-injection removed from response), F8 (mode: dry-run defaults), F9 (cache by tenantId+personaId), F10 (fail-open detail enum) |
| `spec.md` | F1 (real verdict enum values), F6 (3 response + 1 input validator), F7 (per-call-site tier), F10 (FR-009 fail-open), F3 (FR-010 additive wire) |
| `contracts/quality-event-push.md` | F3 (additive over existing type, preserve idempotencyKey/assistantId/originalText/rewrittenText) |
| `contracts/rules-reload.md` | F11 (skip+deadletter), F9 (cache key personaId) |
| `tasks.md` | F4 (single darExecute call), F4 (T030a cost test with custom rules), F9 (personaId cache), F11 (deadletter) |
| `quickstart.md` | F13 (real line numbers 457/899/1085/481), F14 (console→logger) |

## Real Code Signatures (Grounding)

**validator_runs** (`models/validators.ts`):
- `verdict` enum: `no_op|append_disclaimer|block|rewrite|error|strip|pass`
- `isDryRun`, `validatorName`, `confidence`, `matchedPatterns`, `originalContent`, `remediatedContent`, `createdAt`

**CorrectionRule** (`correction-rules/types.ts`):
- `detector: DetectorConfig` (regex/keyword/pattern/semantic)
- `rewriteInstruction`, `mode: 'rewrite'|'score'`, `scope`, `turnScope`, `rubricItems`, `assistantId`

**validateResponse** (`pipeline.ts`):
- Returns `Promise<string>` (not object). Writes to `validator_runs` internally.
- 3 response validators (NOT 4). `format-injection` is input-only.

## Findings NOT Fixed (Deferred)

- **F12** (MEDIUM): Re-run analyze — process step, not a spec fix. Must re-run `/speckit.analyze` after these fixes.
- **F15** (LOW): Citation fix (`dar-pipeline.ts:90` → `types.ts:32`). Fixed in quality-event-push.md header note.
