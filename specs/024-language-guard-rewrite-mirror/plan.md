# Implementation Plan: Language Guard — LLM Rewrite Remediation + Language Mirroring

**Branch**: `024-language-guard-rewrite-mirror` | **Date**: 2026-06-20 (review-fixed) | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/024-language-guard-rewrite-mirror/spec.md` (post-review clarified)

## Summary

Phase 2 of language guard: replace `strip/block` remediation with LLM-based rewrite/translation and add inbound language detection for mirroring. Implements tiered remediation: system directive -> langid detect -> translate-pass (platform model) -> regenerate (main model) -> fallback (strip/block). Review fixes (F1-F15 from `reviews/claude.md`) applied to spec and plan.

## Technical Context

**Language/Version**: TypeScript / Node.js
**Primary Dependencies**: `chat-service.ts`, `LanguageGuardValidator`, `LLMClient`
**Storage**: JSONB config in database (023 extension)
**Testing**: Unit/Integration tests for `LanguageGuardValidator`, `chat-service.ts`
**Target Platform**: Node.js runtime
**Project Type**: Backend Service (engine)
**Performance Goals**: langid < 1s, translate < 3s, buffered delivery for active guards; total remediation budget ≤ min(AGENT_MAX_EXECUTION_MS, channel_ack_timeout)
**Constraints**: cost-sensitive (platform models), no PII logging, buffered delivery for active guards, platform-model routing opt-in for BYOK tenants (NFR-4)
**Scale/Scope**: Active guard scenarios for multi-language personas

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Source of Truth Discipline**: N/A — governs `clai-helpers` CLI + `.claude/` transpile pipeline, not engine runtime.
- **II. Transformer, Not Fork**: N/A — same as above.
- **III. Protected Slots over Hand-Editing**: N/A — no managed template files in engine.
- **IV. SemVer Discipline**: N/A — applies to CLI package versioning, not engine feature.
- **V. Token Economy**: N/A — governs AI artifact files, not runtime cost.
- **VI. Cross-AI Review Gate**: PASS — this feature is undergoing `/speckit.review` (2 external reviewers). Gate enforced before implement.
- **VII. Artifact Versioning**: PASS — stage snapshot tags will be created via `snapshot-stage.ps1 -Stage <stage> -Slug 024-language-guard-rewrite-mirror`.
- **VIII. Self-Maintaining Knowledge**: PASS — post-implementation lessons will be captured via `/speckit.retrospective`.

## Project Structure

### Documentation (this feature)

```text
specs/024-language-guard-rewrite-mirror/
├── spec.md              # Clarified specification
├── plan.md              # This file (includes data-model section below)
├── tasks.md             # Task breakdown
└── reviews/             # External reviews + analyze
```

### Source Code (REAL paths — review F3 fix)

```text
packages/core/src/
├── services/
│   └── chat-service.ts          # Directive injection (:1010), buffered delivery, agentic remediation
├── services/validators/
│   └── language-guard.ts        # Remediation pipeline: detect → translate → regenerate → fallback
└── types/
    └── validator.js             # LanguageGuardConfig type (JSONB, no standalone config file)
```

**Structure Decision**: Integrated into existing `packages/core/src/services/chat-service.ts` and `packages/core/src/services/validators/language-guard.ts`. Config is a JSONB type in `validator.js`, not a standalone file.

## Phase 0: Research (review F2 — platform model plumbing)

### R1: Verify LLMClient platform-model call capability

**Question**: Can `LLMClient` call a platform (non-BYOK) model for langid/translate, bypassing tenant BYOK keys?

**Method**: Read `LLMClient` source, check provider config path. If not supported — design minimal extension (platform provider config in env, separate from tenant BYOK).

**Blocker**: If `LLMClient` cannot route to platform models → T2 (remediation) is blocked until plumbing is added (becomes T0).

### R2: Latency budget measurement

**Question**: What are real-world latencies for `LANG_GUARD_LANGID_MODEL` and `LANG_GUARD_TRANSLATE_MODEL`?

**Method**: Probe calls against platform models, measure p50/p95. Feed into NFR-2 budget arithmetic.

## Data Model (review F1 — design content)

### LanguageGuardConfig (extended)

```typescript
interface LanguageGuardConfig {
  // Phase 1 (017/023)
  enabled: boolean;
  allowedLanguages: string[];        // BCP-47 codes from supported set
  version: string;                   // 023

  // Phase 2 (024)
  targetPolicy: 'mirror' | 'fixed';  // default 'mirror' if allowed>1
  fixedLanguage?: string;            // required if targetPolicy='fixed'
  fallbackLanguage: string;          // default = allowedLanguages[0]
  remediation: 'translate' | 'strip-block';  // default 'strip-block' (NFR-5 backward-compat)
  langidMinConfidence?: number;      // default 0.7
  allowPlatformModelRouting?: boolean; // default false (NFR-4 data governance)
}
```

### TargetResolution (per-message)

```typescript
interface TargetResolution {
  target: string;                    // BCP-47 code
  source: 'mirror' | 'fixed' | 'fallback' | 'degraded';
  langidConfidence?: number;
}
```

### RemediationResult

```typescript
interface RemediationResult {
  type: 'pass' | 'translated' | 'regenerated' | 'stripped' | 'blocked' | 'degraded' | 'skipped';
  sourceLang?: string;
  targetLang?: string;
  fidelityOk?: boolean;
  reason?: string;                   // e.g. 'funnel_malformed', 'langid_timeout'
}
```

### Supported Language Set (FR-010)

```typescript
const BCP47_TO_SCRIPTS: Record<string, string> = {
  // Original 9
  ru: 'Cyrillic', en: 'Latin', zh: 'Han', ar: 'Arabic',
  hi: 'Devanagari', he: 'Hebrew', th: 'Thai', ko: 'Hangul', ja: 'Kana',
  // СНГ additions (10)
  kk: 'Cyrillic', uk: 'Cyrillic', uz: 'Latin', ky: 'Cyrillic',
  hy: 'Armenian', ka: 'Georgian', az: 'Latin', be: 'Cyrillic',
  tg: 'Cyrillic', mo: 'Cyrillic',
};
// Total: 19 languages
```

## Contracts (review F1 — at least langid/translate prompts)

### langid call contract

```text
Input: { text: string, candidates: string[] }  // candidates = allowedLanguages
Output (structured): { lang: BCP47, confidence: float }
Model: LANG_GUARD_LANGID_MODEL (env)
Timeout: LANG_GUARD_LANGID_TIMEOUT_MS (default 3000)
Fallback: script-only detect + fixed target (FR-009)
```

### translate call contract

```text
Input: {
  text: string,                    // masked answer (placeholders for numbers/prices/dates/URL/code)
  target: BCP47,
  context?: string                 // fenced user message for context
}
Output: { translated: string }     // with placeholders restored verbatim
Model: LANG_GUARD_TRANSLATE_MODEL (env)
Timeout: LANG_GUARD_TRANSLATE_TIMEOUT_MS (default 3000)
Fallback: regenerate (FR-006) → strip/block (FR-007)
```

### Fidelity check

```text
Compare (pre-translate vs post-translate):
  - Numbers: parseFloat equality (locale-invariant, review F11)
  - Code blocks: exact string match
  - URLs: exact string match
  - Currency symbols: presence check ($, €, ₽, etc.)
Mismatch → fidelity fail → FR-006
```

## Latency Budget (review F7)

```text
Worst-case remediation path:
  generation_ms + langid_ms(inbound) + detect_ms + translate_ms + fidelity_ms + regenerate_ms + detect_ms

Budget rule:
  If (projected_total > min(AGENT_MAX_EXECUTION_MS, channel_ack_timeout))
    → skip regenerate, go directly to strip/block (FR-007)

Measured values (from R2):
  langid_p95: <to be measured>
  translate_p95: <to be measured>
```

## Config Validation Rules (review F13)

1. `fallbackLanguage` must be in `allowedLanguages` → else 400 on PUT.
2. `targetPolicy='fixed'` requires `fixedLanguage` → else 400.
3. `allowedLanguages.length === 1` → `targetPolicy` ignored (always pin).
4. `fixedLanguage` set with `targetPolicy='mirror'` → warning in audit, field ignored.
5. All language codes must be in `BCP47_TO_SCRIPTS` (supported set) → else 400.
6. `langidMinConfidence` if set must be in [0, 1].

## Complexity Tracking

No violations.
