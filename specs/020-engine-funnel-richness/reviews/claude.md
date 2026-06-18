# SpecKit Review: 020-engine-funnel-richness

**Reviewer**: claude
**Reviewed at**: 2026-06-18T16:00:00Z
**Commit**: cfd0969085a50f7b953b2de5e8feba5efa3ee7f4
**Artifacts reviewed**: spec.md, plan.md, tasks.md, research.md, data-model.md, contracts/metadata.md, reviews/analyze.md, reviews/context-for-review.md

## ⚠️ Independence caveat

This reviewer is a Claude variant. `analyze.md` is also Claude self-consistency. Per Principle VI, this review does NOT count as a non-Claude external reviewer. Still need ≥2 distinct non-Claude PASS verdicts.

## Summary

The spec is comprehensive — 17 user stories, 26 FRs covering cascade delivery, variable substitution, adaptive intro, slot extraction, guards, humanization, anytime stages, and a global rerun budget. The task breakdown (31 tasks, 6 parallel lanes) is well-structured with a clear critical path. The data-model and contracts are concrete with Drizzle preview code. **The headline risk is the multi-LLM pipeline cost and latency**: in the worst case, a single user turn can trigger 5+ LLM calls (intro + main gen + banned-words rerun + anti-repeat rerun + slot extraction + intent fallback). The spec addresses this with FR-026 (global cap maxTurnReruns=2) and NFR-6 (observability), but the cap may be too generous for the cost-sensitive BYOK model, and the cap's accounting is ambiguous about which calls are "reruns" vs "pipeline steps."

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | **HIGH** | Cost/Performance | **Worst-case LLM calls per turn unaccounted.** FR-026 caps *reruns* at 2, but a normal turn (no reruns) already makes 3-4 LLM calls: (1) adaptive intro, (2) main generation, (3) slot extraction, (4) intent fallback for anytime/affirmative. With 2 reruns (banned-words + anti-repeat), worst case = 6 LLM calls per user message. For BYOK tenants paying per token, this could be 6× the expected cost. NFR-1 says "LLM modes p95 < 3s" — but 6 sequential LLM calls will be 6-18s, not 3s. | Clarify in FR-026: the cap counts ALL generative calls (not just reruns), OR document that intro/extraction/intent run in parallel (not sequential). Add NFR: "total LLM cost per turn < N tokens" as a budget. Consider: intro and extraction use lightweight models (already noted), but they still count toward latency. |
| F2 | **HIGH** | Edge case | **Anytime trigger + slot extraction race.** FR-010 (extraction) runs synchronously after reply. FR-015 (anytime) checks triggers *before* scoring. If an anytime stage is triggered, the conversation switches stages — but extraction (running post-turn) extracts against the *old* stage's slot definitions, not the anytime stage's. The next turn's `requiredSlots` guard checks against the anytime stage, but slots were extracted for the previous stage. | Specify: when an anytime stage is triggered mid-turn, slot extraction should use the *new* (anytime) stage's slot definitions, not the previous stage's. Or: extraction runs against ALL defined slots globally (simpler, slightly less precise). |
| F3 | **HIGH** | Hidden assumption | **`conversations.slots` JSONB concurrent writes.** FR-010 writes slots sync post-turn. But if two messages arrive in rapid succession (user double-sends, common in messengers), two extraction steps may write to the same `conversations.slots` JSONB concurrently → last-write-wins → data loss. The spec doesn't mention row-level locking or merge semantics. | Add: slot extraction acquires a conversation-level lock (Redis SET NX or DB SELECT FOR UPDATE) before writing. Or: use JSONB merge (`||`) instead of full overwrite. Document the concurrency model. |
| F4 | MEDIUM | Failure mode | **Adaptive intro LLM failure → no fallback specified.** FR-008 says intro is a pre-gen LLM call. If the intro LLM call fails (timeout, rate limit, model error), what happens? Skip intro and deliver fragment without bridge? Block the turn? The spec is silent. | Specify: intro failure → graceful skip (fragment delivered without intro, warning logged). Intro is enrichment, not critical path. |
| F5 | MEDIUM | Consistency | **`backspace_simulation` in spec vs contract.** FR-023 says metadata "may include" backspace simulation. contracts/metadata.md defines it with `{ chance, keys }`. But `keys` is defined as `string[]` (neighboring keys for target character) — this is per-character, not per-message. The metadata structure doesn't make clear: is this one simulation event for the entire message, or per-character metadata for the adapter to replay? | Clarify: `backspace_simulation` is a *directive* (chance + keyboard layout reference), not a per-character script. Adapter decides which character to "typo" based on chance. Simplify contract: `{ chance: number, enabled: boolean }`. |
| F6 | MEDIUM | Security | **Slot extraction stores PII in `conversations.slots`.** Phone numbers, emails, names extracted from user messages are written to JSONB. No retention policy mentioned. GDPR/152-ФЗ implications: how long are slots kept? Who can read them? The spec mentions `locked` slots but not slot TTL or deletion. | Add NFR or edge case: slot retention = conversation TTL (when conversation is archived/deleted, slots go with it). Document that slots contain PII and access is RBAC-controlled (owner/admin only). |
| F7 | MEDIUM | Stakeholder clarity | **"Лёгкая модель" for intro/extraction — which model?** FR-008 and FR-010 say "lightweight model" / "cheap model." But the Engine uses per-assistant BYOK (011). Does intro/extraction use the *same* provider as main generation? Or a global "cheap" model? If per-assistant, then a tenant with an expensive provider pays premium for intros. | Specify: intro/extraction uses the assistant's configured LLM provider (BYOK), but with a "fast" model tier if configured (011 model-tiering). If no fast tier configured → use the main model (fallback). This connects to 024 Method B's model-tiering. |
| F8 | LOW | Underspec | **Anti-repeat embedding model.** FR-016 says "embed current + previous reply; cosine > 0.85." Which embedding model? BGE-M3 (existing RAG embeddings)? A separate model? If BGE-M3, embeddings may already be cached from RAG indexing — reuse. | Clarify: use existing BGE-M3 embeddings (already deployed for RAG). No new model needed. |
| F9 | LOW | Task gap | **T005 "apply migration to local DB" contradicts Standing Order 5.** The Engine repo constitution says "Never execute database migrations directly. Generate `.sql` files for review." Task T005 says "Create migration SQL... and apply to local DB." This is a violation of the project's own standing orders. | Change T005 to "Create migration SQL (review-only, do NOT apply)." Match the Product repo pattern (023 Task 0.2). |
| F10 | LOW | Consistency | **Context-for-review mentions "Sync Post-Turn Slot Extraction" runs "after the reply is sent to the channel adapter" — but spec FR-010 says "sync до завершения хода... после генерации ответа."** The context doc says "Zero user-facing latency, as it runs after the reply is sent." But if extraction runs *before* turn-done (as spec says), it must complete before the next message can be processed — adding latency to the *gap* between turns, not to the reply itself. | These are consistent (extraction doesn't delay the reply, but does delay "turn done"). Clarify in context-for-review: "runs between reply-sent and turn-done, adds 0.5-2s to backend processing, invisible to user unless they send next message immediately." |

## Alternative approaches considered

- **Parallel LLM calls instead of sequential pipeline**: FR-026 defines a fixed-order pipeline (intro → gen → guards → anti-repeat → retell). An alternative: run intro + main gen in parallel (intro doesn't depend on gen output), and only guards/anti-repeat are sequential. This halves latency for the common (no-rerun) case. Worth considering if NFR-1 p95 < 3s is a hard target.
- **Slot extraction as async worker (rejected by spec)**: The spec explicitly chose sync extraction to ensure `requiredSlots` guards see fresh data. This is correct — async would create a race where the guard checks stale slots. The sync choice is justified, but the latency cost should be explicitly budgeted.

## VERDICT

```yaml
verdict: HIGH
reviewer: claude
reviewed_at: 2026-06-18T16:00:00Z
commit: cfd0969085a50f7b953b2de5e8feba5efa3ee7f4
critical_count: 0
high_count: 3
medium_count: 4
low_count: 3
note: "Strong artifact set — comprehensive spec, concrete Drizzle preview, well-structured tasks. 3 HIGH are all cost/concurrency concerns: worst-case 6 LLM calls/turn (latency + BYOK cost), anytime+extraction race condition, and concurrent JSONB writes. All fixable in spec without rework. Independence caveat: Claude reviewing Claude-authored artifacts."
```
