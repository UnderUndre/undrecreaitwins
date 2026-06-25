# SpecKit Review: 028-big-context-window-llm-as-rag

**Reviewer**: claude
**Reviewed at**: 2026-06-25T06:56:00Z
**Commit**: 3b5328aa20f0d18e6f7cbe8ef1e3edd4318c4af9
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/grounding-config.md, reviews/antigravity.md — **cross-checked against live engine code** (`packages/core/src/...`)

## Summary

Strong, mature spec — eight clarifications, real failure-mode thinking (PG-version guard, token-count cascade, embeddings-status lifecycle, orphan sweep), and antigravity's F1–F5 are all reflected in the current plan/tasks/data-model. But I read the actual engine types, and the load-bearing claim "`GroundingContext` interface не меняется, только semantics" is **false**: the real `metadata` is `{documentId, chunkIndex}` (chunkIndex required, no `priority`), defined twice. There's also a spec↔tasks contradiction on the token-count fallback, a redundant CASCADE migration (the FK already cascades), and a buggy PG-version guard. Verdict **HIGH** — same level antigravity reached, but on different, code-grounded findings.

> Independence caveat (Principle VI): I authored 028's clarifications this session, so this is not a fully arm's-length review. antigravity is the other distinct provider. Both verdicts are HIGH (neither PASS), so the gate is not met regardless — fix, then ideally get a 3rd, truly-independent provider.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|----|----------|------|---------|----------------|
| F1 | HIGH | Logical consistency (code-grounded) | The real `GroundingContext.metadata` is `{ documentId: string; chunkIndex: number }` — `chunkIndex` **required**, **no `priority`** (`interfaces/IGroundingEngine.ts:13-16`). But FR-002 + Clarification #6 say big-context returns `metadata: { documentId, priority }` and claim "the `GroundingContext[]` return type не меняется, только semantics." That's wrong: carrying `priority` REQUIRES an interface change, and `chunkIndex` is meaningless for a whole-document item (no chunk) yet required — consumers reading `metadata.chunkIndex` get a fabricated value. | Change the interface: add `priority?`, make `chunkIndex?` optional (or a sentinel for whole-doc). Update FR-002/Clarification #6 — it IS an interface change. Add a task to migrate consumers that read `chunkIndex`. |
| F2 | HIGH | Inconsistency (spec↔tasks) | FR-005 says: if `count_tokens` is unreachable/errors, "fall back to a `chars/4` estimate + log a warning" — a **2-tier** cascade (OmniRoute → chars/4). But tasks T014 + plan.md:25 specify a **3-tier** cascade (OmniRoute → `js-tiktoken` cl100k_base → chars/4 only if tiktoken throws). The spec still mandates the exact Cyrillic-undercount path antigravity's F3 closed in tasks. Spec and tasks disagree on the budget-safety mechanism. | Update FR-005 to the 3-tier cascade (a local tokenizer is never "network-unreachable" — chars/4 is last resort only on tiktoken import/OOM failure). Align spec ↔ tasks ↔ plan. |
| F3 | MEDIUM | Redundant migration (code-grounded) | `document_chunks.document_id → documents.id` is **already** `onDelete: 'cascade'` (`models/documents.ts:30-32`). data-model.md T001 presents CASCADE as a new addition (`DROP CONSTRAINT IF EXISTS … ADD … ON DELETE CASCADE`), and T023 adds a sweep worker as the "safety net" for a FK that already cascades. The DROP/ADD also assumes the constraint name `document_chunks_document_id_fkey`; if Drizzle named it differently, `DROP IF EXISTS` no-ops and `ADD` creates a duplicate FK. | State CASCADE already exists; make the migration verify the actual constraint name before touching it (or drop the DROP/ADD entirely). Keep the sweep worker only if manual-SQL deletes are a real threat — otherwise it's belt-on-belt. |
| F4 | MEDIUM | Duplicate type (code-grounded) | `GroundingContext` is defined **twice** — `interfaces/IGroundingEngine.ts:10` (canonical) and a local re-declaration in `services/grounding/retrieval.ts:6-13`. Adding `priority`/optional `chunkIndex` (F1) must touch BOTH or they drift; TS structural typing hides the drift until a consumer reads `.priority`. Neither spec/plan/tasks mention reconciling the duplicate. | Add a task: collapse to one `GroundingContext` (import from `interfaces/`), delete the `retrieval.ts` copy, then make the F1 change once. |
| F5 | MEDIUM | Failure mode (bug in the F4-fix) | The lz4 PG-version guard (data-model.md:82) uses `substring(current_setting('server_version_num') for 2)::int` — first 2 chars. For PG9.x, `server_version_num` = `90xxx` → `"90"` → `90 ≥ 14` → **runs the lz4 ALTER on PG9.x and breaks** — the exact failure the guard was meant to prevent. (PG10-16 happen to work: 5-6 digit nums start with 10–16.) | Compare numerically: `current_setting('server_version_num')::int >= 140000`. Don't slice digits. |
| F6 | MEDIUM | Testability | SC-001 ("100% accuracy on exact-match data — no hallucinations on prices/names") is the headline success criterion but has **no verification task** and is non-deterministic (LLM output). T011 tests isolation/grounding wiring, not exact-match accuracy. | Add a golden-Q&A regression task (fixed doc set → expected exact answers, asserted with tolerance), or soften SC-001 to "grounded-on-correct-document" which IS testable. State how SC-001 is validated. |
| F7 | MEDIUM | Process / artifact integrity | `reviews/antigravity.md` is **polluted**: lines 1-37 are a valid antigravity review (verdict HIGH), but lines 41-273 are a stray Claude session transcript/work-log ("The user wants me to fix all the findings…", "Гибрид выбран", "Готово") appended after the VERDICT block. The review record is corrupted; a future reader / gate audit sees junk. | Truncate `antigravity.md` to its VERDICT block. The accidental transcript belongs in `.ai/dialogs/log/`, not a review artifact. |
| F8 | LOW | Terminology | `IGroundingEngine.query(query, tenantId, twinId)` uses `twinId` (`IGroundingEngine.ts:27`); spec/plan/data-model/contract use `personaId`/`persona`. Same entity, two names across the boundary. | Note `twinId ≡ personaId` once, or normalize. Harmless but trips implementers. |
| F9 | LOW | Guardrail / redaction | `retrieval.ts:114` logs via `console.warn` (repo standard is consola `logger`). FR-010 mandates log redaction of document text — ensure the NEW big-context retrieval/truncation path uses the redacting logger, not `console.*`, or full doc text can leak to stdout. | Add a task note: big-context path logs via the redacting logger only; assert no doc body in logs (FR-010 already has the log-scan test — extend it to the new path). |
| F10 | LOW | Perf (caching vs truncation) | FR-011/T009 order docs as a stable prefix for OmniRoute cache hits, but FR-006 truncation drops/reorders docs by priority+recency when over budget — every truncation-boundary change or priority edit busts the cached prefix. Inherent, but unstated. | One line in FR-011: cache hits are per-(persona, doc-set, budget) snapshot; priority/truncation changes are expected cache-miss boundaries. |

## Alternative approaches considered

- **One-GroundingContext-per-document vs a single concatenated context with doc delimiters.** FR-002 returns one item per doc (preserves boundaries — good for per-doc logging/attribution). But the real `chunkIndex`-shaped metadata fights this (F1). An alternative the spec didn't weigh: keep the chunk-shaped `GroundingContext` for vector mode, and introduce a **separate** `DocumentContext` type for big-context (one per doc, with `priority`, no `chunkIndex`), rather than overloading the chunk type with fake `chunkIndex`. Cleaner types, at the cost of a second shape chat-service must format. Worth weighing against F1's "make chunkIndex optional."

## VERDICT

```yaml
verdict: HIGH
reviewer: claude
reviewed_at: 2026-06-25T06:56:00Z
commit: 3b5328aa20f0d18e6f7cbe8ef1e3edd4318c4af9
critical_count: 0
high_count: 2
medium_count: 5
low_count: 3
```
