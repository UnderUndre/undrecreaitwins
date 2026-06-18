# SpecKit Review: 020-engine-funnel-richness

**Reviewer**: codex
**Reviewed at**: 2026-06-18T04:40:48Z
**Commit**: cfd0969085a50f7b953b2de5e8feba5efa3ee7f4
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/metadata.md, quickstart.md, research.md, .specify/memory/constitution.md, reviews/context-for-review.md

## Summary

The feature is ambitious but unusually well-covered at the user-story level: cascade delivery, slots, guards, humanization, anytime stages, media, metrics, and backward compatibility are all present. The headline weakness is that several runtime contracts are still underspecified or inconsistent across artifacts, especially metadata shape, LLM budget accounting, anytime stack semantics, and slot write atomicity. I found no direct constitution violation, but the implementation should not proceed without tightening these areas.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | HIGH | Cross-document contract | Response metadata has two incompatible shapes. `spec.md:193`, `spec.md:198`, `spec.md:230`, and `spec.md:237` describe flat `response.metadata.delay_ms` / `response.metadata.typing_chunks` plus `response.media[]` and `blocked_by_guard`, while `contracts/metadata.md:23`, `contracts/metadata.md:38`, `research.md:62`, and `tasks.md:87` use nested `metadata.humanization.*` and `metadata.media`. Channel adapters could implement against the wrong contract and silently ignore pacing/media/guard signals. | Pick one canonical response shape before implementation. Align FR-023/FR-025, Key Entities, `contracts/metadata.md`, `research.md`, quickstart examples, and T021/T022. Add a contract test that asserts the exact JSON returned to Telegram/Avito adapters. |
| F2 | HIGH | Cost/performance | FR-026 says intent/trigger LLM fallbacks and slot extraction count in the turn budget (`spec.md:202`), and the review context explicitly asks that hybrid fallback be accounted for (`reviews/context-for-review.md:29`). But `research.md:82-86` tracks only `banned_words_rerun + anti_repeat_rerun`, while tasks only wire budget checks for output guard and anti-repeat (`tasks.md:77`, `tasks.md:110`); T024 does not mention budget or metrics for the affirmative/anytime LLM fallback. This can exceed cost/latency assumptions even when the rerun cap is respected. | Define separate counters for total LLM calls/cost per turn and reruns per turn. Include adaptive intro, main generation, intent/trigger fallback, contextual retell, slot extraction, banned reruns, and anti-repeat reruns in metrics and fail-safe logic. Add integration tests for budget exhaustion involving intent fallback plus guard reruns. |
| F3 | HIGH | Edge case / state machine | Anytime LIFO behavior is too thin for nested triggers. `spec.md:91-93` and `spec.md:139-141` require push/pop with max depth 3; `research.md:52-60` says "when resolved" but does not define resolution criteria, self-trigger behavior, trigger precedence, duplicate stack entries, stale stage IDs, or what happens if an anytime stage triggers another anytime stage and then the original stage advances/deletes. `tasks.md:99-100` only covers a single happy-path E2E. | Specify deterministic trigger ordering, no-op rules for current-stage/self reentry, duplicate prevention, max-depth behavior, pop criteria, stale-stage fallback, and whether return targets are stage IDs or stage snapshots. Add nested anytime, max-depth, same-stage trigger, and missing-return-stage tests. |
| F4 | HIGH | Data integrity / concurrency | Slot extraction writes structured data into `conversations.slots` after the reply (`spec.md:59-61`, `spec.md:165-167`), with locked slots enforced by extraction (`spec.md:186`, `tasks.md:66`). The data model is a single JSONB column (`data-model.md:35-39`, `data-model.md:77`), and T015 allows hooking extraction into either `ChatService` or `FunnelRuntime` (`tasks.md:67`) without requiring the same conversation lock/transaction as the turn. Rapid double messages, retries, or extraction outside the runtime lock can produce last-write-wins loss or overwrite a locked slot. | Mandate a conversation-scoped lock or DB transaction covering post-turn extraction and slot merge. Define JSONB merge semantics, optimistic version/turn-id checks, and locked-slot enforcement at write time, not only in the LLM service. Add a concurrency test with two overlapping turns updating different slots. |
| F5 | MEDIUM | Security/privacy | Template mode injects values from slots, context, and RAG metadata directly into outbound text with zero LLM call (`spec.md:47-49`, `spec.md:154-156`, `quickstart.md:19-26`). There is no escaping or typed-context rule for Markdown/HTML/link contexts in Telegram, Avito, email, or webhooks, and media URLs are accepted as plain text (`spec.md:131-135`, `data-model.md:11`). User-provided slot values could break formatting, impersonate links, or create adapter-specific injection surprises. | Add a variable value policy: typed slots, text-only default escaping per adapter, explicit rich-text opt-in, URL validation/allowlist for media, and tests for Markdown/HTML metacharacters in slot values. |
| F6 | MEDIUM | Performance / UX | Pacing formula lacks bounds. `spec.md:193` and `research.md:38` define length-based delay plus sentiment variance, and SC-005 expects 2500ms for 200 chars (`spec.md:246`), but no min/max caps, chunk size limits, grapheme handling, or channel-specific limits are specified. Long generated replies could create extreme delays or huge chunk arrays. | Specify clamp ranges for `delay_ms`, max chunks, chunk sizing rules, Unicode/grapheme length handling, and per-channel override behavior. Add tests for empty, short, 200-char, very long, emoji/Cyrillic, and media-only replies. |
| F7 | MEDIUM | Test coverage | Backward compatibility is a hard requirement (`spec.md:209`, `spec.md:248`), but tasks only add focused unit tests and a single anytime E2E (`tasks.md:47`, `tasks.md:68`, `tasks.md:78`, `tasks.md:100`). There is no explicit regression suite for existing 003 funnels without new fields, no metadata contract test, and no migration/default-value test. | Add a backward-compatibility E2E using an existing funnel fixture with no new fields, plus migration/default tests proving old rows behave as `deliveryMode: 'llm'`, no intro, no guards, and unchanged metadata consumers. |
| F8 | LOW | Task clarity | Task names in Phase 6 say "User Story 5, 21, 22" (`tasks.md:72`), but US-21/US-22 do not exist; these appear to mean FR-021/FR-022. This is small, but it can confuse agent dispatch and traceability. | Rename the phase to "US5 / FR-021 / FR-022" or split the task references into user-story and functional-requirement columns. |

## Alternative approaches considered

- **Two-level budget model**: Keep `maxTurnReruns` as a strict rerun cap, but add a separate `maxTurnLLMCalls` or `maxTurnLLMCost` budget for all LLM calls. This preserves the current FR-026 intent while making cost and latency observable.
- **Normalized slot update log**: Instead of relying only on `conversations.slots` JSONB, record per-turn slot deltas in a child table/event log and materialize the latest slot map. That is heavier than the current plan, but it gives auditability, merge semantics, and easier locked-slot enforcement.
- **Explicit metadata versioning**: Add `metadata.schema_version` or a shared TypeScript contract export used by both Engine and channel adapters. This reduces adapter drift as humanization/media fields evolve.

## VERDICT

```yaml
verdict: HIGH
reviewer: codex
reviewed_at: 2026-06-18T04:40:48Z
commit: cfd0969085a50f7b953b2de5e8feba5efa3ee7f4
critical_count: 0
high_count: 4
medium_count: 3
low_count: 1
```
