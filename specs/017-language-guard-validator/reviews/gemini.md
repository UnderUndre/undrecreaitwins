# SpecKit Review: 017-language-guard-validator

**Reviewer**: gemini
**Reviewed at**: 2026-06-10T12:00:00Z
**Commit**: HEAD
**Artifacts reviewed**: spec.md, plan.md, tasks.md, .specify/memory/constitution.md

## Summary

The Language Response Guard feature is conceptually solid and integrates seamlessly into the existing validator pipeline. The static code-point range detection is a sound, high-performance choice. However, the current design has a critical blind spot regarding technical/developer personas that output code blocks (which are almost entirely Latin script). Additionally, there is an architectural inefficiency where the same validator configuration is fetched from the database twice per chat turn.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | CRITICAL | Logic / Edge Case | A Russian developer assistant (or any technical bot with non-Latin `allowedLanguages`) will be completely broken when outputting code blocks. Code (Python, JS, HTML, etc.) is almost entirely composed of Latin characters and ASCII symbols. If `allowedLanguages: ["ru"]` (Cyrillic only), a response containing a 40% code block will trigger the `blockThreshold` (0.30) and replace the whole response with the fallback message. The assumption that code is "short inline" and won't exceed 30% is completely false for technical personas. | Exclude markdown code blocks (\`\`\`...\`\`\`) and inline code (\`...\`) from the script contamination calculation entirely. |
| F2 | HIGH | Performance / Architecture | T008 adds a DB query (`query validator_configs`) inside `ChatService.buildSystemPrompt()`. The validator pipeline already queries this exact same config during the validation phase. This introduces a redundant DB query per chat turn, increasing latency and DB load. | Fetch persona validator configs once at the beginning of the chat request lifecycle and pass the resolved config to both `buildSystemPrompt` and the `ValidatorPipeline`. |
| F3 | HIGH | Logical consistency / Spec | The formula for "non-compliant fraction" is undefined in the spec. If it is `non_compliant_chars / total_chars`, then a response with 80% spaces/punctuation and 20% Chinese characters will have a 20% fraction. If it is `non_compliant_chars / classified_script_chars` (ignoring punctuation), it is 100%. This ambiguity will lead to unpredictable strip/block behavior and makes thresholds impossible to tune reliably. | Explicitly define the formula in the spec: e.g., `non_compliant_chars / (total_chars - common_chars)`. |
| F4 | MEDIUM | UX / Logic | The `strip` remediation silently removes non-compliant characters. If 15% of a sentence is Chinese characters mixed with Russian, stripping them will result in grammatically broken, stitched-together words. While this fulfills the prompt constraint, it provides a terrible user experience. | Consider whether `strip` is truly viable for fractions as high as 29%, or if stripped regions should be replaced with a visible marker like `[censored]` so the end-user knows content was removed. |
| F5 | MEDIUM | Architecture / Types | T008 assumes `buildSystemPrompt` has access to `tenantId`. If `ChatService` only receives the `Persona` object and the persona doesn't eagerly load its `tenantId` property (which is common if `tenantId` is just a foreign key), this query will fail or require an extra join. | Ensure `tenantId` is available in the context passed to `buildSystemPrompt` without an extra DB lookup, or document how it will be retrieved. |

## Alternative approaches considered

- Instead of stripping non-compliant characters (which can leave garbled text), you could ask the LLM to rewrite it natively, though this violates FR-011 (Zero additional LLM calls on happy path - though this wouldn't be the happy path).
- To solve the code block issue without regex, another approach is to whitelist specific common English technical terms and syntax alongside the primary language, but regex-excluding markdown blocks is much safer and deterministic.

## VERDICT

```yaml
verdict: CRITICAL
reviewer: gemini
reviewed_at: 2026-06-10T12:00:00Z
commit: HEAD
critical_count: 1
high_count: 2
medium_count: 2
low_count: 0
```
