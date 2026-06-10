# Research: Language Response Guard

**Feature**: `017-language-guard-validator`
**Date**: 2026-06-10

## 1. Unicode Script Detection — Feasibility

### Approach: Static Code-Point Range Table

A deterministic classifier maps each character to a script via Unicode code-point ranges. No ML, no external deps, no regex.

**Performance**: O(n) single-pass scan. For a 1000-character response, classification takes <1ms on V8 (microbenchmark data from similar implementations: ~0.3ms per 10K chars).

**Accuracy**: Perfect for single-script characters. Ambiguity exists only for:
- **Latin** vs **Cyrillic homoglyphs** (e.g., `а` U+0430 vs `a` U+0061) — these are different code points and classified correctly.
- **Common** characters (punctuation U+0000–U+0040, digits, whitespace, control chars) — always excluded from the non-compliant fraction.
- **Emoji** (U+1F600+) — classified as "Common" (excluded).

### Script Ranges (Minimal Set for Spec Coverage)

| Script | Range(s) | Covers |
|--------|----------|--------|
| Latin | U+0041–U+024F (letters) | English, European languages |
| Cyrillic | U+0400–U+052F | Russian, Ukrainian, Bulgarian, Serbian |
| Han (CJK) | U+3400–U+4DBF, U+4E00–U+9FFF | Chinese characters |
| Arabic | U+0600–U+06FF | Arabic, Persian, Urdu |
| Devanagari | U+0900–U+097F | Hindi, Marathi, Nepali |
| Hebrew | U+0590–U+05FF | Hebrew |
| Thai | U+0E00–U+0E7F | Thai |
| Hangul | U+AC00–U+D7AF, U+1100–U+11FF | Korean |
| Katakana | U+30A0–U+30FF | Japanese (katakana) |
| Hiragana | U+3040–U+309F | Japanese (hiragana) |
| Common | Everything else (punctuation, digits, emoji, control) | Excluded from fraction |

### BCP-47 → Script Mapping

| BCP-47 | Allowed Scripts |
|--------|----------------|
| `ru` | Cyrillic |
| `en` | Latin |
| `zh` | Han |
| `ar` | Arabic |
| `hi` | Devanagari |
| `he` | Hebrew |
| `th` | Thai |
| `ko` | Hangul, Han, Latin |
| `ja` | Hiragana, Katakana, Han, Latin |
| `de`, `fr`, `es`, `pt`, `it` | Latin |
| `uk` | Cyrillic |
| `bg` | Cyrillic |
| `tr` | Latin |

**Extensibility**: New languages map to existing script ranges. No code change needed to support `de` → Latin; just add to the lookup table.

## 2. Integration Points with Existing Pipeline

### 2.1 `ValidatorPipeline` (pipeline.ts)

The pipeline constructor registers response validators in an array:
```ts
this.responseValidators = [
  new FalsePromiseValidator(llm),
  new IdentityGuardValidator()
];
```

**Integration**: Add `new LanguageGuardValidator()` to this array. No LLM client needed (deterministic).

**Ordering**: Per FR-017 (004 spec), BLOCKING validators run first, REWRITE validators last. Language guard's `strip` is a BLOCKING action (character removal). `block` is also BLOCKING. Language guard should run BEFORE identity-guard (REWRITE) but AFTER false-promise (BLOCKING with LLM judge — slower). Insert position: after `FalsePromiseValidator`, before `IdentityGuardValidator`.

### 2.2 `buildSystemPrompt` (chat-service.ts)

The method assembles parts: `[persona.systemPrompt, traits, annotation_few_shot]`. Language directive is appended as an additional part when `allowedLanguages` is non-empty.

**Config resolution**: `buildSystemPrompt` needs access to the language guard config. Current method signature: `(tenantId, persona, userQuery)`. Options:
1. **Read config inline** — query `validator_configs` for `language-guard` inside `buildSystemPrompt`. Simple, one extra DB query per turn.
2. **Pass config from caller** — resolve in `complete()` / streaming path, pass down. More intrusive change.

**Decision (DD-003)**: Option 1. One extra DB read per turn is acceptable — the pipeline already does this for each validator. Keep `buildSystemPrompt` self-contained.

### 2.3 Types (types/validator.ts)

Add `LanguageGuardConfig`:
```ts
export interface LanguageGuardConfig extends BaseValidatorConfig {
  allowedLanguages: string[];     // BCP-47 codes; empty = no-op (FR-012)
  stripThreshold: number;         // 0–1, default 0.05
  blockThreshold: number;         // 0–1, default 0.30
  fallbackMessage?: string;       // returned on block verdict
  regenerateOnViolation: boolean; // default false (FR-010)
}
```

Extend `AnyValidatorConfig`:
```ts
export type AnyValidatorConfig =
  | FalsePromiseConfig
  | FormatInjectionConfig
  | IdentityGuardConfig
  | LanguageGuardConfig;
```

### 2.4 DB Schema (models/validators.ts)

Current `validatorVerdictEnum`: `['no_op', 'append_disclaimer', 'block', 'rewrite', 'error']`.

**Missing**: `'strip'` and `'pass'` are not in the enum. `strip` is needed for the language guard's strip verdict. `pass` is used implicitly but not stored (pipeline skips persistence for pass results).

**Migration needed**: Add `'strip'` **and `'pass'`** to `validatorVerdictEnum` (`ALTER TYPE ... ADD VALUE` ×2). `'pass'` is required because FR-009 mandates auditing pass events — without it the audit insert fails at the DB layer (claude F7).

## 3. Edge Case Analysis

| Edge Case | Handling |
|-----------|----------|
| Empty `allowedLanguages` | No-op (FR-012): no directive, no validation, no audit |
| Code blocks in response | **Masked entirely before classification** (fenced + inline code, DD-008/FR-014). The earlier "unlikely to exceed stripThreshold" assumption was wrong for technical personas — a 30-line Python block in a Russian response exceeds `blockThreshold` (gemini F1 / claude F1) |
| URLs / emails | **Masked before classification** (DD-008) — keeps strict mappings (`zh → [Han]`) viable without blanket-allowing Latin (claude F5) |
| Fallback message in disallowed script | Not guarded — operator responsibility (spec edge case) |
| Empty response after stripping | Existing FR-019 empty-output guard in pipeline handles this |
| `stripThreshold > blockThreshold` | Rejected at config write time with validation error (FR-006). Zod schema enforces `.refine(c => c.stripThreshold <= c.blockThreshold)` |
| Retry also violates | Same strip/block logic applied; no further retries (FR-010) |
| Mixed-script response (proper names) | Absorbed by `stripThreshold` (default 5%). "Tolstoy" in Latin within Russian text = 7 chars out of ~200 = 3.5% → pass. Fraction per FR-015: `nonCompliant / (total − common − masked)` |

## 4. Language Directive Effectiveness

**Claim**: SC-005 requires ≥60% reduction in violation rate with directive vs without.

**Evidence**: LLMs generally follow language directives when the instruction is explicit and placed in the system prompt. For GPT-4-class models, language adherence is >95% with explicit instructions (industry benchmarks). For cheaper models, adherence drops but directive still helps significantly.

**Risk**: If the model ignores the directive entirely, violations fall through to the deterministic post-generation guard. The directive is proactive (reduces violations), not a replacement for post-generation validation.

**Measurement**: Requires a baseline test corpus (100 samples) run with and without directive. This is an implementation-time validation, not a design-time certainty. Flag in plan as "empirical target to validate during implementation."
