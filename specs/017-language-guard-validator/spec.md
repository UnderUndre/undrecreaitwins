# Feature Specification: Language Response Guard

**Feature Slug**: `017-language-guard-validator`
**Engine Branch**: `feature/017-language-guard-validator` (undrecreaitwins)
**Created**: 2026-06-10
**Status**: Draft
**Repo**: `undrecreaitwins` (engine). Product config UI is out of scope for this spec.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Tenant Enforces Response Language (Priority: P1)

A tenant has deployed a customer-facing assistant intended to respond only in Russian. The underlying language model occasionally produces responses contaminated with Chinese characters, Arabic script, or other off-language content. The tenant wants every response delivered to their end users to contain only permitted scripts — even when the model hallucinates into another language.

**Why this priority**: Direct, user-visible defect. Language contamination breaks user trust immediately and creates accessibility issues. This is the primary motivating scenario for the entire feature.

**Independent Test**: Configure `allowedLanguages: ["ru", "en"]` and `mode: active` for a persona. Submit prompts known to induce Chinese-script responses. Verify that (a) small contamination is stripped and the cleaned response is delivered, and (b) heavy contamination is replaced with the fallback message.

**Acceptance Scenarios**:

1. **Given** a persona with `allowedLanguages: ["ru", "en"]` and `mode: active`, **When** the AI produces a response containing 3% Chinese characters, **Then** the Chinese characters are removed and the cleaned response is delivered to the user.

2. **Given** a persona with `allowedLanguages: ["ru", "en"]` and `mode: active`, **When** the AI produces a response where 40% of the content is Chinese text, **Then** the user receives the configured fallback message instead of the contaminated response.

3. **Given** a persona with `allowedLanguages: ["ru", "en"]` and `mode: active`, **When** the AI produces a fully compliant Russian-language response, **Then** the response is delivered unchanged and no additional processing delay is observable.

---

### User Story 2 — Operator Audits Violations Without Enforcement (Priority: P2)

A new tenant wants to understand how often their assistant produces off-language content before committing to enforcement. They need a way to observe violations without affecting users.

**Why this priority**: Safe rollout path. Forcing enforcement from day one risks silently replacing legitimate responses with fallback messages if the configuration is miscalibrated.

**Independent Test**: Configure `mode: dry-run`. Submit requests that are known to trigger language violations. Verify that (a) end users receive the original AI response unmodified, and (b) violation events with the correct verdict appear in the audit log.

**Acceptance Scenarios**:

1. **Given** `mode: dry-run`, **When** the AI produces a language-violating response, **Then** the response is delivered to the user unchanged.

2. **Given** `mode: dry-run`, **When** a language violation occurs, **Then** a language guard audit entry is written with the verdict that would have been applied in active mode, the fraction of non-compliant content, and the detected scripts.

---

### User Story 3 — Language Directive Reduces Violations at the Source (Priority: P2)

The system should communicate the language expectation to the AI before it generates a response, reducing violations proactively. Post-generation correction is a last resort.

**Why this priority**: Prevention is cheaper than correction. Fewer violations mean less stripping/blocking and a more natural user experience. The language directive is a prerequisite for the "zero extra LLM calls on compliant responses" success criterion.

**Independent Test**: With `allowedLanguages` configured, intercept the full context forwarded to the AI. Verify it includes a language constraint clause. Measure violation rate in a controlled test corpus with and without the directive.

**Acceptance Scenarios**:

1. **Given** a persona with `allowedLanguages: ["ru", "en"]` configured, **When** a user message is processed, **Then** the context forwarded to the AI includes an instruction specifying the permitted response languages.

2. **Given** a persona with no `allowedLanguages` configured (or empty list), **When** a user message is processed, **Then** no language constraint is added to the AI's context.

---

### User Story 4 — Per-Persona Language Configuration (Priority: P3)

A tenant runs multiple personas on the same workspace: a Russian customer support bot and an English developer assistant. Each persona must have independent language settings.

**Why this priority**: Necessary for multi-persona tenants. Without per-persona scoping, enabling the guard for one assistant breaks others on the same account.

**Independent Test**: Configure Russian-only guard on Persona A and English-only guard on Persona B within the same tenant. Submit identical off-language prompts to both. Verify that each persona's guard applies its own `allowedLanguages` independently.

**Acceptance Scenarios**:

1. **Given** Persona A has `allowedLanguages: ["ru"]` and Persona B has `allowedLanguages: ["en"]`, **When** the AI for Persona A generates an English-only response, **Then** Persona A's guard flags it as a violation while Persona B's guard passes an identical response.

---

### Edge Cases

- **Empty `allowedLanguages`**: Guard is a no-op — no directive injected, no validation run, no audit entry written.
- **Code blocks in response**: Content inside markdown fenced code blocks (```` ``` ```` … ```` ``` ````) and inline code (`` ` `` … `` ` ``) is **excluded** from the non-compliant fraction entirely (masked before classification). Without this, a technical persona with non-Latin `allowedLanguages` (e.g. a Russian developer bot) emitting a 30-line Python block would exceed `blockThreshold` and have a legitimate response replaced — the feature would be broken for developer personas. (review: gemini F1 / claude F1)
- **URLs and email addresses**: Masked from the fraction the same way as code spans (deterministic regex). Keeps strict script mappings like `"zh" → [Han]` viable — a URL in a 200-char Chinese message must not trigger `strip`. (claude F5, alternative remedy: masking instead of blanket-allowing Latin, which would let a fully-English response pass a Chinese-only persona.)
- **Strip output quality**: `strip` removes characters mid-sentence; above ~15% contamination the output degrades noticeably (stitched words). Operators who care about strip quality should keep `blockThreshold` low; the default `dry-run` mode exists precisely to calibrate this before enforcement. A `stripMaxFraction` promote-to-block cap is a possible follow-up knob, not in MVP. (gemini F4 / claude F4)
- **Fallback message in disallowed script**: Not guarded — operators are responsible for configuring a compliant fallback.
- **Empty response after stripping**: The existing empty-output guard in the response pipeline handles this case — the cleaned response falls back to the original or a safe default.
- **`stripThreshold > blockThreshold` misconfiguration**: The system MUST reject this at configuration write time with a validation error.
- **Retry also violates (`regenerateOnViolation: true`)**: The same strip/block logic is applied to the retry result. No further retries are attempted.
- **Very long system prompt**: Language directive is appended; total prompt length is the caller's responsibility.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support a per-persona `allowedLanguages` configuration specifying which languages are permitted in AI responses.
- **FR-002**: When `allowedLanguages` is non-empty, the system MUST inject a language constraint directive into the AI's generation context on every request.
- **FR-003**: After each AI generation, the system MUST evaluate the response for content belonging to scripts outside `allowedLanguages` and produce a verdict.
- **FR-004**: When the non-compliant fraction is detected but falls below `stripThreshold`, the verdict MUST be `strip` — non-compliant characters are removed before delivery.
- **FR-005**: When the non-compliant fraction meets or exceeds `blockThreshold`, the verdict MUST be `block` — the response is replaced with the configured fallback message.
- **FR-006**: `stripThreshold` MUST be less than or equal to `blockThreshold`. Configurations violating this invariant MUST be rejected with a validation error.
- **FR-007**: A `mode` field (`active` | `dry-run`) MUST control whether verdicts are enforced or observed only.
- **FR-008**: The default `mode` for new language guard configurations MUST be `dry-run`.
- **FR-009**: All language guard evaluation events — including `pass`, `strip`, `block`, and dry-run observations — MUST be written to the validator audit log.
- **FR-010**: When `regenerateOnViolation: true` is configured and the violation meets or exceeds `blockThreshold`, the system MAY request one additional generation before applying the final verdict. Default is `false`.
- **FR-011**: The language guard MUST NOT add any LLM calls on the happy path (response fully compliant with `allowedLanguages`).
- **FR-012**: When `allowedLanguages` is empty or absent, the guard MUST be a complete no-op — no directive injection, no validation, no audit entry.
- **FR-013**: Language guard configuration MUST be scoped per (tenant, persona) pair, independent of other personas in the same tenant.
- **FR-014**: Before script classification, the system MUST mask content inside markdown fenced code blocks, inline code spans, URLs, and email addresses — these characters count toward neither the numerator nor the denominator of the non-compliant fraction. (gemini F1, claude F1/F5)
- **FR-015**: The non-compliant fraction MUST be computed as `nonCompliantFraction = nonCompliantScriptChars / scriptChars`, where `scriptChars = totalChars − commonChars − maskedChars` (Common = punctuation, whitespace, digits, emoji, control characters; masked = FR-014 spans). If `scriptChars` is 0, the fraction is 0 (verdict `pass`). Common is a **strict** category, not a fallback: a letter character belonging to no recognized script classifies as `Unknown` and counts as non-compliant — unmapped scripts (Greek, Georgian, Armenian, …) MUST NOT bypass the guard. (gemini F3, claude F2, gemini PR#32 — formula pinned so thresholds and SC-001/SC-005 are measurable)

### Key Entities

- **LanguageGuardConfig**: Per-(tenant, persona) configuration. Fields: `mode` (`active` | `dry-run`), `allowedLanguages` (list of language/script identifiers), `stripThreshold` (fraction 0–1, default 0.05), `blockThreshold` (fraction 0–1, default 0.30), `fallbackMessage` (optional — returned verbatim when verdict is `block`), `regenerateOnViolation` (boolean, default false).
- **LanguageGuardResult**: Output of the evaluation step. Fields: `decision` (`pass` | `strip` | `block`), `nonCompliantFraction` (0–1, computed per FR-015), `detectedScripts` (list of script names found in violation).
- **ValidatorRun** (existing): Audit record. Language guard writes to the same table as other validators, using `validatorName: "language-guard"`.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When `mode: active` and `allowedLanguages` is configured, ≥95% of delivered responses contain only content from permitted languages (measured over a 100-sample corpus of known-violating LLM outputs).
- **SC-002**: The language detection step adds ≤5ms per response on the happy path (verified via benchmark with no violation).
- **SC-003**: Zero additional AI generation calls are made when the response fully passes language validation.
- **SC-004**: 100% of language guard events (pass, strip, block, dry-run) are present in the audit table within the same request cycle.
- **SC-005**: The language directive reduces the raw violation rate by ≥60% compared to an identical persona without the directive (measured on the same 100-sample corpus). **Target, not release gate** — an empirical stretch goal; a measurable reduction below 60% does not fail the feature. (claude F9)
- **SC-006**: A `stripThreshold > blockThreshold` configuration is rejected by the system before being persisted.

---

## Assumptions

- Language/script detection is deterministic (Unicode code-point range analysis); no ML inference is used.
- **Terminology — scripts, not languages**: this feature validates response *scripts* (Unicode code-point ranges), not natural-language identification. `allowedLanguages` maps BCP-47 language codes to permitted Unicode scripts — a Ukrainian response (Cyrillic) passes `allowedLanguages: ["ru"]`. That is acceptable for the feature's purpose (blocking cross-script contamination), but maintainers should not expect language ID. (claude F10)
- The feature integrates into the existing validator pipeline as a new response validator; it runs before rewrite-type validators (consistent with the existing BLOCKING-first ordering).
- **Downstream consumer (018 seam)**: `LanguageGuardValidator` is ALSO invoked by `018-response-quality-rules` DAR **re-validation** (018 FR-007) — after a DAR rewrite, language-guard re-checks the rewritten reply so a rewrite can't ship off-language script. Implication: the validator must be instantiable standalone (detection-only, no pipeline singleton coupling), same as 004's false-promise/identity-guard are for 018. **NOT folded into 018** — language-guard is a fixed 004-family structural guard; 018 is the dynamic operator-rule layer above it.
- **Shared verdict/audit vocabulary (seam A — canonical owner)**: 017 verdicts (`pass`/`strip`/`block`) + the validator audit log align with 018's `verdict` enum (`pass`/`fail`/`rewritten`/`rolled_back`/`overflow_skipped`) and 019's retrieval events — one canonical verdict/audit model across the 004-family + DAR + feedback, not three parallel schemas. **Canonical owner: this spec (017) as the latest 004-family member.** The shared types live at `packages/core/src/types/quality-event.ts`:

  ```typescript
  // CANONICAL — owner: 004-family (017 task T000). Referenced by 018 + 019.
  type QualityVerdict =
    | 'pass'              // shared: no violation detected
    | 'strip'             // 017: minor script contamination removed
    | 'block'             // 017/004: response replaced with fallback
    | 'fail'              // 018: violation detected, not rewritten (score mode)
    | 'rewritten'         // 018: violation fixed via DAR rewrite
    | 'rolled_back'       // 018: rewrite reverted (re-validation failed)
    | 'overflow_skipped'; // 018: rule dropped by ≤4 rewrite cap

  interface QualityEvent {
    verdict: QualityVerdict;
    source: '004-false-promise' | '004-identity-guard' | '017-language-guard' | '018-dar-pipeline';
    tenantId: string;
    personaId: string;
    conversationId: string | null;
    messageId: string | null;
    mode: 'active' | 'dry-run' | 'rewrite' | 'score';
    isDryRun: boolean;
    latencyMs: number;
    metadata?: Record<string, unknown>; // feature-specific payload (detectedScripts, originalText, etc.)
  }
  ```

  Each feature maps its internal types to `QualityVerdict` + `QualityEvent` — no parallel schemas. 018's `QualityEventPush` and 019's retrieval log both serialize from `QualityEvent`. Task T000 (below) creates the module; 018 T005 + 019 T011 depend on it.
- The language directive injection point is the system prompt builder in the AI executor layer — the function that constructs the context forwarded to the AI model on each turn.
- The configuration is stored in the existing per-persona validator config store (no new database table required), using `validatorName: "language-guard"` as the key.
- The language-guard config is resolved **once per request** at the chat-lifecycle entry point and the resolved value is shared by both the system-prompt injection and the validator pipeline — no second DB read for the same `(tenant, persona, 'language-guard')` row in one turn. This also guarantees `tenantId` is available at injection time without an extra lookup. (gemini F2/F5, claude F3)
- Platform default (no config row in DB): feature disabled (no-op for all personas).
- `regenerateOnViolation: true` adds at most 1 extra generation call per message; it is not recursive.
- Mixed-script content is handled in two layers: code spans, URLs, and emails are **masked outright** (FR-014); remaining incidental cross-script characters (proper names like "Tolstoy" in a Russian text) are absorbed by `stripThreshold`.
- `fallbackMessage` defaults to a generic "I can only respond in [languages]" message if not explicitly set; the exact default wording is an implementation detail.
- This spec does not cover a management UI for language guard configuration — operators configure it via the existing validator config API.
