# Prompts for Tasks: 020 Engine Funnel Richness

Промты для спавна агентов на основе `.claude/agents/`. Каждый промт самодостаточный.

**Repo**: `C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins`
**Порядок**: Phase 1-2 (blocking) → Phase 3-9 (parallel lanes where deps allow).

---

## Phase 1-2: Foundation (BLOCKING)

### T001+T002 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo at C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins.

TASK: Setup + verify dependencies for 020-engine-funnel-richness.

1. Create directory: specs/020-engine-funnel-richness/contracts/ (if not exists)
2. Verify these deps are in package.json: drizzle-orm, ioredis, langfuse
3. Check packages/core/src/models/ exists and has funnel-related files

Read: specs/020-engine-funnel-richness/plan.md (Technical Context section)

ACCEPTANCE: directories exist, deps confirmed.
```

### T003 — Agent: `database-architect`

```
You are working on the undrecreaitwins Engine repo at C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins.

TASK: Update Drizzle schemas for funnel richness fields.

Read first:
- specs/020-engine-funnel-richness/data-model.md (full schema spec with Drizzle preview code)

Update these files in packages/core/src/models/:
1. funnel-fragments.ts — add: deliveryMode (pgEnum 'verbatim'|'template'|'llm', default 'llm'), adaptiveIntro (boolean, default false), mediaUrl (text, nullable), deliveryCondition (jsonb, nullable)
2. funnel-stages.ts — add: requiredSlots (jsonb string[], default []), requiresConfirmation (boolean, default false), isAnytime (boolean, default false)
3. funnel-slots.ts — add: locked (boolean, default false), enumValues (jsonb string[], nullable)
4. conversation-funnel-states.ts — add: returnStack (jsonb string[], default [])
5. conversations.ts — add: slots (jsonb, default {})

IMPORTANT: Use pgEnum for deliveryMode (matching existing fragmentTypeEnum pattern). NOT plain text.

ACCEPTANCE: TypeScript compiles; types match data-model.md exactly.
```

### T004 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo at C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins.

TASK: Update shared types for funnel richness.

Read: specs/020-engine-funnel-richness/data-model.md

Update packages/shared/src/types.ts with new TypeScript interfaces:
- FragmentDeliveryMode type ('verbatim' | 'template' | 'llm')
- Extended FunnelFragment interface (deliveryMode, adaptiveIntro, mediaUrl, deliveryCondition)
- Extended FunnelStage interface (requiredSlots, requiresConfirmation, isAnytime)
- Extended FunnelSlot interface (locked, enumValues)
- ConversationFunnelState returnStack
- ResponseMetadata nested shape (funnel, humanization, media, extraction)

ACCEPTANCE: Shared types export all new interfaces; Engine + Product can import.
```

### T005 — Agent: `database-architect`

```
You are working on the undrecreaitwins Engine repo at C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins.

TASK: Generate migration SQL (review-only — DO NOT APPLY).

Read: specs/020-engine-funnel-richness/data-model.md

Create: drizzle/migrations/<timestamp>_funnel_richness/migration.sql

SQL must cover:
- CREATE TYPE delivery_mode ENUM ('verbatim', 'template', 'llm')
- ALTER funnel_fragments: ADD delivery_mode (default 'llm'), adaptive_intro (default false), media_url, delivery_condition
- ALTER funnel_stages: ADD required_slots (default '[]'), requires_confirmation (default false), is_anytime (default false)
- ALTER funnel_slots: ADD locked (default false), enum_values
- ALTER conversation_funnel_states: ADD return_stack (default '[]')
- ALTER conversations: ADD slots (default '{}')

DO NOT run drizzle migrate. Just create the .sql file.

ACCEPTANCE: SQL file created, matches data-model.md, NOT executed.
```

---

## Phase 3: Delivery Cascade + Variables + Conditions (MVP)

### T006 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo at C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins.

TASK: Implement VariableParser for {{slot_name}} substitution.

Read first:
- specs/020-engine-funnel-richness/spec.md FR-005, FR-006, FR-007 (variable parser)
- specs/020-engine-funnel-richness/research.md §1 (Delivery Cascade — Template Mode)

Create: packages/core/src/services/funnel/utils/variable-parser.ts

Logic:
1. Regex: /\{\{(\w+)\}\}/g — find all {{variable}} in text
2. Resolution order: conversation.slots → conversation.context → RAG metadata → fallback
3. Fallback: replace unclosed variable with '[уточнить]' + warning log
4. Return: { text: string (with substitutions), unresolved: string[] (variable names that fell through) }

Pure function — no side effects, no DB calls. Caller provides the slot/context maps.

ACCEPTANCE: Parser finds {{price}} → resolves to slot value; unclosed → [уточнить]; no regex injection risk.
```

### T007 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo at C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins.

TASK: Update FunnelRuntime to handle deliveryMode cascade.

Read first:
- specs/020-engine-funnel-richness/spec.md FR-001..FR-004 (cascade modes)
- specs/020-engine-funnel-richness/research.md §1
- packages/core/src/services/funnel/funnel-runtime.ts (existing — find processMessage or equivalent)

Modify FunnelRuntime.processMessage (or the fragment selection + delivery function):
1. After fragment is selected by scorer — check fragment.deliveryMode:
   - 'verbatim': return fragment.content AS-IS. Zero LLM call. Skip intro, skip guards (banned words don't apply to verbatim).
   - 'template': run VariableParser (T006) on fragment.content → return substituted text. Zero LLM call.
   - 'llm' (default): current behavior — fragment content = instruction for LLM.
2. Set metadata.funnel.delivery_mode in response.
3. Backward compat: if fragment has no deliveryMode field → default to 'llm'.

CRITICAL: verbatim mode must NOT call LLM. This is a cost/perf guarantee (p95 < 50ms).

ACCEPTANCE: 3 modes tested; verbatim = zero LLM; template = substituted, zero LLM; llm = current behavior.
```

### T008 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo at C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins.

TASK: Implement DeliveryConditionEvaluator.

Read: specs/020-engine-funnel-richness/spec.md FR-018, US-15

Create: packages/core/src/services/funnel/utils/condition-evaluator.ts

Logic:
1. fragment.deliveryCondition = { slot: string, equals: string } (AND logic for multiple conditions)
2. Evaluate BEFORE scoring: check conversation.slots[condition.slot] === condition.equals
3. Non-matching fragments → excluded from candidate set (never scored)
4. No deliveryCondition → always included (default)

Integrate into FunnelRuntime: filter fragment list BEFORE passing to scorer.

ACCEPTANCE: Fragment with { slot: 'tier', equals: 'premium' } excluded when slot.tier='basic'; included when 'premium'.
```

### T009 — Agent: `test-engineer`

```
You are working on the undrecreaitwins Engine repo at C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins.

TASK: Unit tests for delivery cascade + variables + conditions.

Read: specs/020-engine-funnel-richness/spec.md US-1, US-2, US-15

Create: packages/core/tests/unit/funnel-delivery.test.ts (use vitest)

Test cases:
1. Verbatim fragment → output = exact content, zero LLM mock calls
2. Template fragment with {{price}} → output has price substituted from slots
3. Template fragment with {{unknown}} → output has [уточнить]
4. LLM fragment → LLM mock called, output from mock
5. DeliveryCondition match → fragment included in scoring
6. DeliveryCondition non-match → fragment excluded
7. No deliveryMode field → defaults to 'llm' (backward compat)
8. Verbatim with {{braces}} in text → NOT substituted (literal)

ACCEPTANCE: All 8 cases pass.
```

---

## Phase 4: Adaptive Intro

### T010 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo at C:\Users\Admin\Documents\Repos\underhelpers\under-ai-helpers\undrecreaitwins.

TASK: Implement AdaptiveIntroService.

Read first:
- specs/020-engine-funnel-richness/spec.md FR-008, US-3
- specs/020-engine-funnel-richness/research.md §2 (Adaptive Intro)
- packages/core/src/services/llm-client.ts (existing LLM call pattern)

Create: packages/core/src/services/llm/adaptive-intro.ts

Logic:
1. Input: { userMessage: string, fragmentObjective: string }
2. LLM call with intro prompt — MUST encourage: разговорные частицы (ну, же, ведь, короче, слушай), lowercase short phrases, опускание подлежащего, инверсию порядка слов
3. Output: 1-sentence bridge string (max 100 chars)
4. Model: assistant's BYOK provider with fast-tier (if configured); else main model
5. **Failure handling (review fix C-F4)**: LLM timeout/error → return null (graceful skip). Intro is enrichment, not critical.
6. Designed to run **in parallel** with main generation (caller wraps in Promise.all with timeout)

ACCEPTANCE: Returns 1-sentence bridge; failure → null (not throw); prompt contains particle/lowercase instructions.
```

### T011 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Integrate AdaptiveIntroService into FunnelRuntime.

Read: packages/core/src/services/funnel/funnel-runtime.ts, packages/core/src/services/llm/adaptive-intro.ts (T010)

Modify FunnelRuntime delivery pipeline:
1. When fragment.adaptiveIntro === true AND deliveryMode !== 'verbatim':
   - Launch AdaptiveIntroService in parallel with main LLM generation
   - Promise.race with timeout (2s): if intro not ready by gen completion → skip intro
   - If intro ready: prepend to final reply
2. Verbatim/template fragments → skip intro entirely

ACCEPTANCE: Intro prepended when ready; skipped on timeout; verbatim never gets intro.
```

### T012 — Agent: `test-engineer`

```
You are working on the undrecreaitwins Engine repo.

TASK: Unit tests for adaptive intro.

Create: packages/core/tests/unit/adaptive-intro.test.ts

Test cases:
1. Normal intro generation → bridge contains conversational particles (ну, же, ведь or similar)
2. Short lowercase phrases in output
3. LLM failure (mock reject) → returns null (graceful skip, no throw)
4. LLM timeout (mock delay >2s) → caller skips, fragment delivered without intro
5. Verbatim fragment → intro service NOT called

ACCEPTANCE: All 5 cases pass.
```

---

## Phase 5: Slot Extraction

### T013 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Implement SlotExtractorService.

Read first:
- specs/020-engine-funnel-richness/spec.md FR-010, FR-011, US-4
- specs/020-engine-funnel-richness/research.md §3 (Slot Extraction)

Create: packages/core/src/services/llm/slot-extractor.ts

Logic:
1. Input: { userMessage, assistantReply, slotDefinitions: SlotDef[], conversationSlots: Record<string, any> }
2. SlotDef = { name, description, locked?, enum?, required? }
3. LLM call with extraction prompt — includes ALL slot definitions (not per-stage, review fix C-F2)
4. Output: { extracted: Record<string, any>, confidence: number }
5. Validate against slot schema: locked slots → skip; enum slots → validate value in enum
6. Invalid extraction → null (don't save garbage)

ACCEPTANCE: Extracts phone from "мой телефон +79991234567"; respects locked; validates enum.
```

### T014 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Add locked + enum enforcement to SlotExtractorService.

Read: T013 output, spec.md FR-019, FR-020

Add to SlotExtractorService:
1. Before extraction: filter out locked slots from slotDefinitions (locked = skip extraction)
2. After extraction: for enum slots, validate extracted value ∈ enum values
3. Invalid enum value → null + log (don't save)
4. Locked slot overwrite attempt → ignore + log

ACCEPTANCE: Locked slot 'email' never overwritten; enum slot 'tier' rejects 'diamond' if not in enum.
```

### T015 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Hook SlotExtractorService into post-turn pipeline.

Read first:
- specs/020-engine-funnel-richness/spec.md FR-010, FR-012
- specs/020-engine-funnel-richness/research.md §3
- packages/core/src/services/funnel/funnel-runtime.ts

Modify FunnelRuntime post-turn processing:
1. After reply generated (but BEFORE lock release + BEFORE turn-done):
   - Call SlotExtractorService with ALL funnel slot definitions (review fix C-F2)
   - Acquire conversation-level lock (Redis SET NX, TTL 30s) if not already held
   - Write result to conversations.slots via JSONB MERGE (|| operator — review fix C-F3)
   - Locked slots enforced at DB write time (not just in extractor)
2. Extraction failure → slots unchanged, reply sent normally (graceful)
3. Extraction must complete before turn-done (so next turn's requiredSlots guard sees fresh data)

CRITICAL: The conversation lock must remain held during extraction. Do NOT release lock between reply-gen and extraction (review fix Gemini-F2).

ACCEPTANCE: Slots updated after turn; next turn sees fresh data; concurrent writes merged (not last-write-wins).
```

### T016 — Agent: `test-engineer`

```
You are working on the undrecreaitwins Engine repo.

TASK: Unit + concurrency tests for slot extraction.

Create: packages/core/tests/unit/slot-extraction.test.ts

Test cases:
1. Phone number "+79991234567" in user message → slot 'phone' extracted
2. Email "test@mail.ru" → slot 'email' extracted
3. Enum slot 'tier' with value 'diamond' (not in enum) → rejected (null)
4. Locked slot 'email' already filled → NOT overwritten
5. Concurrency test (review fix C-F3): simulate two overlapping extractions updating different slots ('phone' + 'name') → both preserved in JSONB merge (not last-write-wins)

For concurrency test: mock the DB write, verify it uses merge (||) not overwrite.

ACCEPTANCE: All 5 cases pass; concurrency test proves merge semantics.
```

---

## Phase 6: Banned Words + Output Guard

### T017 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Implement BannedWordsFilter.

Read: specs/020-engine-funnel-richness/spec.md FR-021, US-5

Create: packages/core/src/services/llm/guards/banned-words.ts

Logic:
1. Input: { reply: string, config: { hard: RegExp[], soft: string[] } }
2. Hard block: test reply against each hard regex. If match → return { blocked: true, matches: string[] }
3. Soft warn: check reply for soft keywords. If match → return { blocked: false, warnings: string[] }
4. Hard regex examples: /как искусственный интеллект/i, /я языковая модель/i
5. Soft keywords: ['в качестве', 'следует отметить', 'инновационный', 'потенциал']

Config comes from funnel config (per-funnel) or global default.

IMPORTANT: Banned words do NOT apply to verbatim fragments (spec edge case — author is responsible).

ACCEPTANCE: Hard match → blocked:true; soft match → warnings; clean text → { blocked: false, warnings: [] }.
```

### T018 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Implement OutputGuard pipeline with rerun logic.

Read: specs/020-engine-funnel-richness/spec.md FR-022, FR-026

Create: packages/core/src/services/llm/guards/output-guard.ts

Logic:
1. Post-generation: run BannedWordsFilter (T017) on generated reply
2. If hard-blocked AND reruns remaining (within maxTurnReruns=2 global cap):
   - Rerun main generation with repair prompt: "Избегай фраз: [matched patterns]. Переформулируй."
   - Re-check output
3. If still blocked after max reruns → fail-safe: send best-effort OR handoff signal
4. Track budget: decrement maxTurnReruns on each rerun; check maxTurnLLMCalls (review fix C-F1)

ACCEPTANCE: Hard-blocked reply → rerun with repair; still blocked after 2 → handoff; budget tracked.
```

### T019 — Agent: `test-engineer`

```
You are working on the undrecreaitwins Engine repo.

TASK: Unit tests for banned words + output guard.

Create: packages/core/tests/unit/banned-words.test.ts

Test cases:
1. Reply with "я языковая модель" → hard blocked
2. Reply with "в качестве" → soft warned (not blocked)
3. Clean reply → no blocks, no warnings
4. Verbatim fragment with banned word → NOT blocked (verbatim exempt)
5. OutputGuard: 1st gen blocked → rerun → 2nd gen clean → pass
6. OutputGuard: 1st + 2nd gen blocked → handoff signal
7. Budget: maxTurnReruns=0 → no rerun, immediate handoff

ACCEPTANCE: All 7 cases pass.
```

---

## Phase 7: Pacing + Humanization

### T020 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Implement PacingCalculator.

Read: specs/020-engine-funnel-richness/spec.md FR-023, research.md §2 (Pacing Calculator)

Create: packages/core/src/services/funnel/utils/pacing.ts

Formula (review fix Codex-F6 — with bounds):
1. delay_ms = clamp((content.length * char_rate) + base_delay + sentiment_variance, 500, 8000)
   - char_rate = 15ms per character (typing speed simulation)
   - base_delay = 800ms (thinking time)
   - sentiment_variance = +2000ms if user message is angry (sentiment detected), else 0
2. typing_chunks: split reply into max 10 chunks of max 500 chars each (grapheme-aware via Intl.Segmenter)
3. Return { delay_ms, typing_chunks }

ACCEPTANCE: 200-char reply → ~3800ms delay; angry user → +2000ms; empty reply → 500ms (min); 10000-char reply → 8000ms (max).
```

### T021+T022 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Enrich response metadata with humanization + backspace simulation.

Read: specs/020-engine-funnel-richness/contracts/metadata.md §2

Modify FunnelRuntime response builder:
1. After reply is finalized → call PacingCalculator (T020)
2. Set response.metadata.humanization = { delay_ms, typing_chunks, backspace_simulation: { enabled: true, chance: 0.01 } }
3. backspace_simulation is a DIRECTIVE (not per-character script) — adapter decides which char to typo

The metadata.humanization shape MUST match contracts/metadata.md exactly (canonical nested shape, review fix Codex-F1).

ACCEPTANCE: Response includes metadata.humanization.* with correct shape; delay_ms within [500,8000].
```

---

## Phase 8: Advanced Guards + Anytime Stages

### T023 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Add requiredSlots guard to stage advance logic.

Read: specs/020-engine-funnel-richness/spec.md FR-013, US-10

Modify FunnelRuntime advanceStage() (or equivalent):
1. Before advancing to next stage: check stage.requiredSlots[]
2. For each required slot: verify conversation.slots[slotName] exists and is non-null
3. If any unfilled → stay on current stage + generate prompt asking user for missing slot
4. If all filled → proceed with advance

ACCEPTANCE: Stage with requiredSlots ['phone','name'] → blocked if phone missing; advances when both filled.
```

### T024 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Implement IntentClassifier for affirmative advance.

Read: specs/020-engine-funnel-richness/spec.md FR-024, US-11

Create: packages/core/src/services/llm/intent-classifier.ts

Logic (hybrid, review fix C-F1):
1. Fast-path: regex/keyword match for affirmatives: /\b(да|ок|давайте|хорошо|согласен|поехали|окей|угу)\b/i
2. If match → return { affirmative: true } (zero LLM call)
3. If no match → LLM fallback (within maxTurnLLMCalls budget): "Is this message affirmative? Reply yes/no"
4. If LLM says yes → { affirmative: true }
5. If LLM says no or ambiguous → { affirmative: false }

ACCEPTANCE: "Давайте!" → true (regex); "хз наверное" → LLM fallback; "нет" → false.
```

### T025 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Implement ConfirmationGate.

Read: specs/020-engine-funnel-richness/spec.md FR-014, US-12

Modify FunnelRuntime:
1. Before advancing to stage with requiresConfirmation=true:
   - Generate confirmation prompt with slot values: "Оформляем заказ на {{product}} за {{price}}₽?"
   - Wait for user response (next turn)
2. On next turn: check IntentClassifier (T024) for affirmative
3. Affirmative → advance; negative/ambiguous → stay on current stage

ACCEPTANCE: Confirmation prompt shown; "Да" → advance; "Нет" → stays.
```

### T026 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Implement AnytimeTrigger + LIFO returnStack.

Read first:
- specs/020-engine-funnel-richness/spec.md FR-015 (FULL LIFO semantics — review fix Codex-F3)
- specs/020-engine-funnel-richness/research.md §4 (Anytime Stages LIFO Stack)

Modify FunnelRuntime:
1. BEFORE normal fragment scoring: scan all stages with isAnytime=true for triggers
2. Trigger detection: hybrid — keyword/regex fast-path → LLM intent fallback (T024 pattern)
3. **Full LIFO semantics**:
   - Trigger ordering: anytime stages evaluated in `order` field (deterministic, first match wins)
   - Self-trigger: current stage is anytime and re-triggers → no-op (skip)
   - Duplicate prevention: same stage ID already in returnStack → no-op
   - Push: currentStageId to returnStack (max 3; 4th → reject + stay + log)
   - Pop: when anytime stage resolutionCriteria met → pop returnStack → set currentStageId
   - Stale stage: popped stageId no longer exists → pop again (skip missing) + log
4. Trigger consumes budget (maxTurnLLMCalls if LLM fallback used)

ACCEPTANCE: Anytime triggered → pushes stack; resolved → pops; nested (depth 2); self-trigger no-op; max-depth reject.
```

### T027 — Agent: `test-engineer`

```
You are working on the undrecreaitwins Engine repo.

TASK: E2E tests for anytime stages.

Create: packages/core/tests/e2e/anytime-stages.test.ts

Test cases (review fix Codex-F3):
1. Happy path: trigger anytime stage → process → resolutionCriteria met → pop back to original
2. Nested anytime: depth 2 (anytime-inside-anytime) → both resolve → back to original
3. Max depth (3): 4th anytime trigger → rejected, stays on current
4. Self-trigger: current anytime re-triggers → no-op
5. Duplicate: same stage already in stack → no-op
6. Stale stage: popped stageId deleted → skip + log, pop next

ACCEPTANCE: All 6 cases pass.
```

### T032 — Agent: `test-engineer`

```
You are working on the undrecreaitwins Engine repo.

TASK: Backward-compat regression E2E.

Create: packages/core/tests/e2e/backward-compat.test.ts

Test: load an existing 003-spec funnel fixture (no new fields — no deliveryMode, no adaptiveIntro, no requiredSlots, no isAnytime, etc.).
Process a test message through FunnelRuntime.

Verify:
1. deliveryMode defaults to 'llm' → LLM is called (current behavior)
2. No adaptive intro generated
3. No guards fire (no bannedWords config, no requiredSlots)
4. Response metadata shape unchanged from 003 behavior (no humanization block if not configured)
5. Slot extraction runs (but with empty slot definitions → no-op)

ACCEPTANCE: Existing funnels work identically — zero regression.
```

### T033 — Agent: `test-engineer`

```
You are working on the undrecreaitwins Engine repo.

TASK: Integration test for LLM budget exhaustion.

Create: packages/core/tests/integration/budget-exhaustion.test.ts

Scenario: Configure a funnel that triggers ALL generative paths:
- Fragment with adaptiveIntro=true
- Banned words config that blocks first reply
- Anti-repeat threshold 0.5 (triggers on similar replies)
- Slot definitions (triggers extraction)
- Anytime stage with LLM-fallback trigger

Set maxTurnLLMCalls=4 (lower than default 6 for test speed).

Process message. Verify:
1. After 4 LLM calls: remaining steps skipped (intro/extraction/anti-repeat)
2. Best-effort reply delivered (not blocked)
3. Metrics emitted: llm_calls_total=4, skipped steps logged
4. No infinite loop

ACCEPTANCE: Budget hit → graceful degradation; no crash; metrics correct.
```

---

## Phase 9: Anti-Repeat + Retell + Metrics

### T028 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Implement AntiRepeatGuard.

Read: specs/020-engine-funnel-richness/spec.md FR-016, US-7

Create: packages/core/src/services/llm/guards/anti-repeat.ts

Logic:
1. After reply generation: embed current reply + previous assistant reply using BGE-M3 (existing embeddings — review fix C-F8)
2. Compute cosine similarity
3. If similarity > 0.85 AND reruns remaining (maxTurnReruns budget):
   - Rerun generation with anti-repeat prompt: "Не повторяй предыдущий ответ. Переформулируй."
4. Max 1 anti-repeat rerun
5. If still similar → send with warning log
6. Verbatim fragments → skip (always same text by design)

ACCEPTANCE: Similar reply → rerun; still similar → send + warn; verbatim → skip check.
```

### T029 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Implement ContextualReteller for stage revisits.

Read: specs/020-engine-funnel-richness/spec.md FR-017, US-8

Create: packages/core/src/services/llm/contextual-reteller.ts

Logic:
1. Detect stage revisit: conversation returns to a stage it was on before (stuck → retry)
2. If revisit AND fragment deliveryMode !== 'verbatim':
   - LLM call: rewrite fragment content with context of current conversation
   - Prompt: "Переформулируй этот фрагмент с учётом текущего контекста диалога. Не повторяй дословно."
3. Verbatim fragments → skip (always literal)
4. Counts toward maxTurnReruns budget

ACCEPTANCE: Stage revisit → reformulated text; verbatim → same text; first visit → no retell.
```

### T030 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Integrate anti-repeat + retell into post-gen pipeline.

Read: T028 (AntiRepeatGuard), T029 (ContextualReteller)

Modify FunnelRuntime post-generation pipeline:
1. After output guard (T018) → check anti-repeat (T028)
2. If anti-repeat rerun needed → rerun within budget
3. After stage transition → check if revisiting → contextual retell (T029)
4. All reruns count toward maxTurnReruns AND maxTurnLLMCalls (two-level budget, review fix C-F1)

Pipeline order (per FR-026): adaptive intro (parallel) → main gen → guards → banned → anti-repeat → retell.

ACCEPTANCE: Pipeline executes in order; budget enforced; no infinite loops.
```

### T031 — Agent: `backend-specialist`

```
You are working on the undrecreaitwins Engine repo.

TASK: Implement metrics emission for all generative paths.

Read: specs/020-engine-funnel-richness/spec.md NFR-6

Modify FunnelRuntime to emit metrics per turn:
- llm_calls_total: count of ALL LLM calls in this turn (intro + gen + guards + extraction + intent + retell)
- llm_cost_total: estimated token cost for all calls
- reruns_used: count of reruns (banned retry + anti-repeat + retell)
- reruns_max: maxTurnReruns config value
- llm_calls_max: maxTurnLLMCalls config value
- pipeline_steps: array of { step: string, fired: boolean, skipped: boolean, reason?: string }
  Steps: 'adaptive_intro', 'main_gen', 'banned_check', 'anti_repeat', 'contextual_retell', 'slot_extraction', 'intent_classify', 'anytime_trigger'

Use existing langfuse/emission pattern. Counters without sampling.

ACCEPTANCE: Metrics emitted per turn; all steps tracked; costs accounted.
```

---

## Execution Order

```
Phase 1-2 (blocking):  T001 → T003 + T004 → T005
Phase 3 (MVP):         T006 → T007 + T008 → T009
Phase 4 (parallel A):  T010 → T011 → T012
Phase 5 (parallel B):  T013 → T014 → T015 → T016
Phase 6 (parallel C):  T017 → T018 → T019
Phase 7 (after 3):     T020 → T021+T022
Phase 8 (after 6):     T023 + T024 → T025 + T026 → T027 + T032 + T033
Phase 9 (after 6):     T028 → T029 → T030 → T031

Parallel lanes:
  Lane 1 [DB]:      T003 → T005
  Lane 2 [BE-Core]: T004, T006 → T007+T008 → T011, T015, T021
  Lane 3 [BE-LLM]:  T010, T013 → T014, T017 → T018 → T028, T029
  Lane 4 [BE-Guard]: T023+T024 → T025, T026
  Lane 5 [E2E]:     T027, T032, T033
  Lane 6 [Metrics]: T031
```
