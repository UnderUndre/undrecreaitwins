# SpecKit Review: 024-language-guard-rewrite-mirror

**Reviewer**: opencode
**Reviewed at**: 2026-06-20T15:30:00Z
**Commit**: cc9f29b46b5c7731330dffb885510b877db87109
**Artifacts reviewed**: spec.md, plan.md, tasks.md, analyze.md, context-for-review.md

## Summary

Spec is thorough on the "what" — tiered remediation, mirror logic, buffered delivery — but the plan is a skeleton and tasks miss two FRs entirely. The headline weakness: **FR-013 (agentic-path coverage) is an explicitly open question that neither plan.md nor tasks.md resolves**, meaning an implementer faces a blocking ambiguity on day one. Secondary concern: the entire design hinges on a platform-model capability (non-BYOK LLM calls) that is assumed but never verified in the plan.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Logical consistency | **FR-013 unresolved.** spec.md:76 leaves agentic-path coverage as "решение на clarify/plan." Neither plan.md nor tasks.md addresses it. Agentic personas currently bypass `ValidatorPipeline` entirely (`chat-service.ts` agentic branch). Implementer doesn't know whether to (a) pipe agentic answers through remediation, (b) document exclusion with a warning in 026, or (c) something else. | Resolve in plan BEFORE implement. Pick one: pipe agentic through guard (preferred — consistent behavior) OR document exclusion with explicit warning. Add a task (T2b or T3b) for whichever is chosen. |
| F2 | HIGH | Hidden assumption | **Platform non-BYOK model call unverified.** spec.md:113: "нужен способ вызвать НЕ-BYOK модель (платформенный provider config)." The entire translate/langid design depends on `LLMClient` supporting platform-model calls that bypass tenant BYOK keys. Plan.md doesn't confirm this capability exists or specify how to add it if it doesn't. | Plan must include a research/spike task: verify `LLMClient` can call platform models without tenant BYOK. If not — design and implement the provider config path FIRST (blocking dependency for T2). |
| F3 | HIGH | Logical consistency | **tasks.md misses FR-012 (audit) and FR-010 (supported languages).** FR-012 requires extending `validator_runs` metadata (`remediation` type, `sourceLang`, `targetLang`). FR-010 requires expanding `BCP47_TO_SCRIPTS` and creating a shared export. Neither has a task. | Add T5: "Expand audit metadata (FR-012)" and T6: "Expand supported language set + shared export (FR-010)." Both block T4 (testing). |
| F4 | HIGH | Failure modes | **No circuit breaker for platform model failures.** FR-009 handles single-message degradation but if the platform provider is down, EVERY inbound message on a mirror persona pays the full langid timeout (3s default) before degrading. At scale, this is a latency cliff with no recovery mechanism. | Add a circuit breaker: after N consecutive langid/translate failures within a window, skip directly to degradation (script-only detect + fixed target) for M minutes. Specify N, M, and reset conditions in plan. |
| F5 | MEDIUM | Edge cases | **Fidelity check definition is incomplete.** spec.md:68, NFR-3: fidelity = "structural verification of numbers/code/URLs." But translate model can introduce semantic errors without touching numbers — negation flips, tense changes, name transliteration variants, added/hallucinated content. Structural diff won't catch these. | Either (a) expand fidelity check to include length-ratio guard (translated text length within X% of original) + negation-word presence check, or (b) explicitly document that semantic fidelity is out of scope and accept the risk. For a sales/pricing bot, (a) is strongly recommended. |
| F6 | MEDIUM | Performance | **Buffered delivery TTFB unquantified.** FR-008 disables streaming for all guard-active personas, even on happy path (no violation). TTFB = full generation + langid + detect + possible translate + fidelity. spec.md:81 mentions budget must fit `AGENT_MAX_EXECUTION_MS` but no arithmetic is done. If generation alone is 8s, adding 1s langid + 3s translate = 12s before first byte — likely triggers hybrid-core fallback_threshold, which fires OVER remediation, producing unpredictable behavior. | Plan must include latency budget calculation: `generation_ms + langid_ms + detect_ms + translate_ms + fidelity_ms ≤ min(AGENT_MAX_EXECUTION_MS, fallback_threshold)`. If it doesn't fit — either raise thresholds for guard-active personas or accept degraded UX explicitly. |
| F7 | MEDIUM | Edge cases | **langid confidence threshold undefined.** spec.md:89 (edge cases) mentions "low-confidence → sticky/fallback" but no FR defines the threshold value, the sticky behavior, or what "low" means numerically. Is it 0.5? 0.7? Model-dependent? | Add a config field `langidMinConfidence` (default 0.7) to FR-011. Define sticky behavior: below threshold → retain previous message's target if within last N turns, else fallback. |
| F8 | MEDIUM | Edge cases | **Supported language set list is "согласованный набор" — undefined.** FR-010 says "минимум +СНГ: kk, uk, uz, ky, hy, ka, az…" but the ellipsis hides the actual commitment. Who agrees on the final list? This blocks FR-010 implementation and 026 UI. | Define the exact BCP-47 code list in plan's data-model section. State which source-of-truth export file 023 and 026 import from. |
| F9 | MEDIUM | Security | **Platform model data retention unspecified.** NFR-4 says "not log in plaintext metrics" but doesn't address whether the platform langid/translate model provider retains input data. User messages and generated answers are sent to a third-party model. For EU/GDPR tenants this may be a DPA issue. | Confirm platform model provider's data retention policy. If zero-retention isn't guaranteed, document in spec §8 (Dependencies) and flag for 026 UI (tenant-visible notice). |
| F10 | LOW | Plan completeness | **plan.md references missing artifacts.** Structure tree (plan.md:39-47) lists `research.md`, `data-model.md`, `quickstart.md`, `contracts/` — none exist. Plan is 65 lines, mostly boilerplate. No architecture decisions, no sequence diagrams, no contract definitions. | Run `/speckit.plan` again or flesh out manually: at minimum add data-model.md (config schema, audit schema) and contracts/ (langid/translate call signatures). |
| F11 | LOW | Stakeholder clarity | **"remediation" is overloaded.** It means both the overall process (directive→detect→translate→regenerate→fallback) AND the config field value (`remediation: 'translate'|'strip-block'`). Confusing for 026 UI design. | Rename the config field to `remediationStrategy` or `onViolation`. Keep "remediation" for the process. |

## Alternative approaches considered

1. **Client-side language detection**: Instead of server-side langid LLM, client could send `Accept-Language` or detect language in the UI. Zero cost, zero privacy concern. Trade-off: less accurate for short/mixed messages, doesn't work for API-only clients. Worth weighing as a complement (client hint as first signal, langid as tiebreaker).

2. **Directive-only phased rollout**: Measure how effective tier 1 (dynamic directive) alone is before building the full translate/regenerate machinery. If directive catches 90%+ of violations, the ROI of the full pipeline drops significantly. Could ship directive + detect first, add translate in a follow-up.

3. **Streaming with post-hoc correction**: Instead of buffering (FR-008), stream the answer, then if violation detected post-generation, send a follow-up correction message. Maintains streaming UX for happy path. Trade-off: user briefly sees wrong-language text; correction message is clunky. But avoids TTFB regression for ALL guard-active messages.

## VERDICT

```yaml
verdict: HIGH
reviewer: opencode
reviewed_at: 2026-06-20T15:30:00Z
commit: cc9f29b46b5c7731330dffb885510b877db87109
critical_count: 0
high_count: 4
medium_count: 5
low_count: 2
```
