# Research: Engine Funnel Richness

## 1. Delivery Cascade Implementation

### Verbatim Mode
- **Logic**: If `fragment.deliveryMode === 'verbatim'`, skip LLM call entirely.
- **Handling**: Return `fragment.content` as `scriptedReply` with `delivery_mode: 'verbatim'` metadata.
- **Exceptions**: No `adaptiveIntro`, no variable substitution, no humanization (as per spec).

### Template Mode
- **Logic**: Use Regex to find `{{variable_name}}`.
- **Resolution Path**:
    1. `conversation.slots[variable_name]`
    2. `conversation.context[variable_name]`
    3. RAG metadata (if available in session)
    4. Fallback: `[уточнить]`
- **Metadata**: `delivery_mode: 'template'`.

### LLM Mode (Default)
- Existing behavior: `fragment.content` is the system instruction.
- Enhancements: Prepend `adaptiveIntro` if enabled.

## 2. Post-Generation Pipeline (The "Plumbing")

We need a consistent pipeline to process LLM outputs before sending.

**Parallelization (review fix C-F1)**: Adaptive intro and main generation run **in parallel** (Promise.all with timeout — if intro not ready by gen completion, skip). Slot extraction and intent fallback also run post-reply (parallel with each other, before turn-done).

1. **Adaptive Intro** (parallel with main gen):
    - Prompt: Cheap model (e.g., Haiku/GPT-4o-mini). Uses assistant BYOK fast-tier (review fix C-F7).
    - Input: Last user message + selected fragment objective.
    - Output: 1 sentence bridge.
    - **Failure → skip** (review fix C-F4).
2. **Output Guard / Banned Words** (sequential, post-gen):
    - Hard Block: Regex scan. If hit → Rerun (up to `maxTurnReruns`).
    - Soft Warn: Keyword scan. Log hit.
3. **Anti-Repeat** (sequential, post-gen):
    - Embedding: **BGE-M3** (existing, review fix C-F8).
    - Cosine similarity check between current reply and last assistant message.
    - If similarity > 0.85 → Rerun with "rephrase" instruction.
4. **Pacing Calculator**:
    - Formula: `delay_ms = clamp((content.length * char_rate) + base_delay + sentiment_variance, 500, 8000)` (review fix Codex-F6).
    - Returns metadata for channel adapters.

## 3. Slot Extraction (Sync Post-Turn)

- **Timing**: Executed after `scriptedReply` is selected/generated, but before the turn is marked "done" in DB.
- **Scope**: Runs against ALL funnel slot definitions (not per-stage — review fix C-F2: anytime trigger may switch stages mid-turn; all-slots extraction covers the new stage).
- **Concurrency (review fix C-F3)**: Acquires conversation-level lock (Redis `SET NX conv:lock:{id} TTL 30s`). Write = JSONB merge (`||`) — preserves concurrent updates. Locked slots never overwritten at DB level.
- **Process**:
    - LLM Prompt with all slot definitions for the funnel.
    - Input: `userMessage` + `assistantReply`.
    - Output: JSON matching slot names.
    - Write to `conversations.slots` via merge.

## 4. Anytime Stages (LIFO Stack)

- **Detection**: Before scoring fragments, check all `isAnytime: true` stages for trigger matches (keyword/intent).
- **Stack Management**:
    - If an anytime stage is triggered:
        1. Push `currentStageId` to `funnelState.returnStack`.
        2. Set `currentStageId` to the anytime stage.
    - When anytime stage is resolved (resolution criteria met):
        1. Pop from `returnStack`.
        2. Set `currentStageId` to the popped ID.
- **Limit**: Max depth 3 (enforced in `FunnelRuntime`).

## 5. Metadata Contract (response.metadata)

```json
{
  "funnel": {
    "fragment_id": "...",
    "delivery_mode": "verbatim | template | llm",
    "stage_transition": { ... }
  },
  "humanization": {
    "delay_ms": 2500,
    "typing_chunks": ["chunk1", "chunk2"],
    "backspace_simulation": { "chance": 0.01, "keys": [...] }
  },
  "media": [
    { "url": "...", "type": "image" }
  ]
}
```

## 6. Global Rerun Budget (FR-026)

- `maxTurnReruns = 2`.
- Tracks sum of: `banned_words_rerun` + `anti_repeat_rerun`.
- If budget exhausted -> Send last "best effort" reply + Log `budget_exhausted`.
