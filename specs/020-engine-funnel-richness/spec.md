# Feature Specification: Engine Funnel Richness — Каскад, Режимы, Переменные, Гуманизация

**Feature Branch**: `020-engine-funnel-richness`
**Created**: 2026-06-18
**Status**: CLARIFIED (session 2026-06-18)
**Repo**: `undrecreaitwins` (Engine)
**Input**: `legacy-script-features-leftovers.ru.md` (unimplemented 017 features), `ai-agent-research-report.ru.md` (industry patterns), `Архитектура-высоконадежных...md` (academic deep-dive).

## 1. Описание

Движок имеет каркас funnel runtime (003: stages, fragments, scoring, stuck safety-net), но **отсутствует «умная начинка»** из оригинального дизайна 017. Фрагменты — plain text без режимов. Нет подстановки переменных. Нет каскада доставки (verbatim → template → LLM). Нет извлечения слотов в БД. Нет гуманизации (banned words, pacing, anti-repeat). Бот звучит как ИИ и не может гарантировать дословную доставку критических фраз.

020 закрывает **все** пробелы: каскад, режимы фрагментов, переменные, адаптивное интро, извлечение слотов, guards, антиповтор, гуманизация (negative constraints, output guard, pacing), anytime/triggered этапы, медиа.

## Clarifications

### Session 2026-06-18

- **Q: Все фичи в скоупе или только обязательные?** → A: **Все** — обязательные + рекомендованные + Phase 2. Объём большой, но это фундамент; без полного набора автоматизация (024) бессмысленна.
- **Q: Гуманизация (pacing, fat-finger) — в Engine или в channel adapters?** → A: **В Engine** (channel-agnostic). Engine возвращает metadata (delay_ms, typing_indicator) в response; channel adapters (Telegram, Avito) применяют физическую задержку. Engine не ждёт сам — он рекомендует.
- **Q: DSPy — внедряем или нет?** → A: **Нет в этом спринте.** DSPy требует Python + training data + separate pipeline. Вместо него: rule-based negative constraints (regex/keyword blacklist) + system-prompt-level style instructions. DSPy = fast-follow когда будет enough training data.
- **Q: Модели памяти (Mem0/Letta/EverOS) — внедряем?** → A: **Нет.** Существующий feedback_memories (019) — достаточно для v1. Внешние memory platforms = research-only, не в этом спринте.
- **Q: Композиция новых генеративных шагов на ход?** → A: **Фикс-порядок + глобальный кап.** Пост-ген конвейер в фиксированном порядке (adaptive intro → main gen → premature/confirmation guards → output guard/banned → anti-repeat → contextual retell), плюс **глобальный кап рерайтов/ретраев на ход** (дефолт ≤2 суммарно поверх пер-фичных лимитов), затем fail-safe (handoff/best-effort). Без бесконечных циклов; ограничивает цену/латенси (FR-026, NFR-1).
- **Q: Когда выполняется slot extraction (US4)?** → A: **Sync в рамках хода, до пометки turn done** (после генерации ответа, можно параллельно с отправкой), чтобы guard requiredSlots (US10/FR-013) на следующем ходе видел свежие слоты. User-facing latency не растёт, но ход не «done» до конца extraction (FR-010, US4).
- **Q: Распознавание intent/триггеров (US9 anytime, US11 affirmative)?** → A: **Гибрид**: keyword/regex fast-path → LLM-классификатор-фолбек только при отсутствии совпадения. Дёшево в типичном случае, точнее на свободном языке; LLM-фолбек учитывается в глобальном капе (FR-026).
- **Q: Наблюдаемость новых LLM-путей?** → A: **Да — NFR на метрики** (NFR-6): per-feature firing counts, доп. LLM-вызовы/ход, rerun/retry counts, какой guard сработал/откатил. Иначе 7+ генеративных веток = чёрный ящик по цене.

## 2. Границы

**Это**: Engine-side runtime features: fragment cascade, fragment modes, variable substitution, adaptive intro, slot extraction to DB, stage guards (premature/blocking), anytime stages, anti-repeat, contextual retelling, delivery conditions, negative constraints, output guard, pacing metadata, media support.

**Это НЕ**: UI редактор (Product `025-funnel-editor-richness`). DSPy pipeline. External memory platforms. Model distillation. CRAG/Self-RAG (separate spec). Conversation analyzer (024 adaptive-onboarding).

## 3. Пользовательские истории

### US-1 — Каскад доставки: verbatim → template → LLM (P1)

Фрагмент имеет `deliveryMode`. При match:
- `verbatim`: текст фрагмента отправляется **дословно**, без LLM. Для критических фраз (цена, условия возврата).
- `template`: текст с `{{variables}}` подставляется из slots/контекста, затем отправляется. LLM не генерирует — только подстановка.
- `llm` (default): текст фрагмента = инструкция для LLM. LLM генерирует ответ, опираясь на fragment content + RAG + context.

**AC**: `fragment.deliveryMode` поле; `verbatim` = zero LLM call, literal output; `template` = variable substitution, zero LLM call; `llm` = current behavior.

### US-2 — Подстановка переменных `{{slot_name}}` (P1)

В тексте фрагментов: `{{customer_name}}`, `{{product}}`, `{{price}}`. При доставке — парсинг `{{}}`, подстановка из conversation slots / context / RAG metadata. Незакрытая переменная → warning + fallback (empty string или `[уточнить]`).

**AC**: regex `\{\{(\w+)\}\}` parser; lookup in conversation.slots → context → RAG metadata; unclosed → `[уточнить]`.

### US-3 — Адаптивное интро (P1)

Перед текстом фрагмента — LLM генерирует короткий «мостик» (1 предложение), связывающий предыдущую реплику клиента с фрагментом. Например: клиент спросил про доставку → интро «Так, по доставке...» → фрагмент с условиями.

**AC**: `fragment.adaptiveIntro: boolean`; при `true` — pre-generation step: LLM call (cheap model) → 1 sentence bridge → prepended to fragment text. Verbatim fragments skip intro.

### US-4 — Структурированное извлечение слотов → DB (P1)

После каждого хода диалога — LLM extracts structured data from user message + assistant reply. Сохраняет в `conversation.slots` (JSONB). Например: user назвал телефон → slot `phone` = «+79991234567».

**AC**: post-turn extraction step; LLM call с extraction prompt (slot definitions from funnel config); writes to `conversations.slots` JSONB; visible in conversation viewer. Extraction **sync до завершения хода** (после отправки ответа, без user-latency) — следующий ход (guard requiredSlots US10) видит свежие слоты (clarif. 2026-06-18).

### US-5 — Negative constraints / output guard (P1)

Запрещённые слова/фразы в выходящем тексте. Два уровня:
- **Hard block** (regex): «как искусственный интеллект», «я языковая модель» → ответ блокируется, rerun с repair prompt.
- **Soft warn** (keyword): «в качестве», «следует отметить», «инновационный» → ответ проходит, но логируется для анализа.

**AC**: configurable banned-words list (per-funnel или global); hard-block → retry (max 2) → fallback to handoff; soft-warn → log + send.

### US-6 — Pacing metadata (P1)

Engine возвращает metadata: `{ delay_ms, typing_chunks }`. `delay_ms` = recommended delay before sending (based on message length + sentiment). Channel adapters применяют физически.

**AC**: `response.metadata.delay_ms` (calculated from reply length + user sentiment); `response.metadata.typing_chunks` (array of text chunks with per-chunk delay — for typing animation).

### US-7 — Anti-repeat (P2)

Сравнение текущего ответа с предыдущим (в той же conversation). Если cosine similarity > 0.85 → rerun с anti-repeat prompt: «не повторяй предыдущий ответ, переформулируй».

**AC**: embed current + previous reply; cosine > threshold → rerun; max 1 rerun; if still similar → send with warning log.

### US-8 — Контекстуальный пересказ (P2)

При возврате к этапу (stuck → retry same stage) — не повторять тот же фрагмент дословно. LLM переформулирует с учётом нового контекста диалога.

**AC**: stage revisit detection; LLM rewrite with context prompt; verbatim fragments skip (always same text — это их смысл).

### US-9 — Anytime / Triggered этапы (P2)

Этап с `isAnytime: true` — может быть активирован из любого места воронки по триггеру (keyword/intent match). После обработки — возврат к прерванному этапу (LIFO stack).

**AC**: `stage.isAnytime` field; trigger = **гибрид: keyword/regex fast-path → LLM-intent-фолбек при отсутствии совпадения** (clarif. 2026-06-18; LLM-фолбек в рамках капа FR-026); LIFO return stack; max 3 anytime stages simultaneously.

### US-10 — Guard преждевременного перехода (P1)

Перед переходом на next stage — проверка: все ли `requiredSlots` текущего stage заполнены? Если нет → бот остаётся на stage + сообщает что нужно уточнить.

**AC**: `stage.requiredSlots[]`; before `advanceStage()` → check all filled; unfilled → stay + prompt user for missing slot.

### US-11 — Утвердительное продвижение (P2)

Если пользователь отвечает «Да/Ок/Давайте/Хорошо» → авто-переход на предложенный next stage. Intent classifier на короткие affirmatives.

**AC**: affirmative intent detection — **гибрид**: regex/keyword fast-path (« да|ок|давайте|хорошо|согласен|поехали») → LLM-фолбек при неоднозначности (clarif. 2026-06-18); auto-advance if stage has pending proposal.

### US-12 — Шлюз подтверждения (P2)

Перед критическим переходом (stage с `requiresConfirmation: true`) — бот спрашивает «Оформляем заказ на [product] за [price]₽?» → ждёт «Да» → переходит.

**AC**: `stage.requiresConfirmation` field; confirmation prompt with slot values; affirmative → advance; negative → stay.

### US-13 — Заблокированные слоты (P2)

Slot с `locked: true` — не может быть перезаписан после первого заполнения. Защита от случайной перезаписи (email, phone).

**AC**: `slot.locked` field; extraction step skips locked slots; UI shows lock icon (Product 025).

### US-14 — Enum-определения слотов (P2)

Slot с `enum: ['option1', 'option2']` — LLM extraction ограничена вариантами. Повышает точность.

**AC**: `slot.enum[]` field; extraction prompt includes allowed values; invalid extraction → null + retry.

### US-15 — Delivery conditions (P2)

Фильтрация фрагментов внутри stage по значениям слотов. `fragment.deliveryCondition: { slot: 'tier', equals: 'premium' }` — фрагмент показывается только если slot matches.

**AC**: `fragment.deliveryCondition` JSONB; evaluated before scoring; non-matching fragments excluded from candidate set.

### US-16 — Медиа в фрагментах (P1)

Фрагмент может содержать `mediaUrl` (image). Engine возвращает `response.media[]` — channel adapter прикрепляет изображение к сообщению.

**AC**: `fragment.mediaUrl` field; Engine returns `response.media[]`; verbatim fragments with media → text + image; LLM fragments with media → LLM text + image.

### US-17 — Стек возврата (LIFO) (P2)

При anytime-этапе → прерванный stage сохраняется в stack → после обработки anytime → pop → возврат. Max depth 3.

**AC**: `conversation.funnelState.returnStack[]`; push on anytime enter; pop on anytime exit; max 3.

## 4. Функциональные требования

### Каскад и режимы

- **FR-001**: `fragment.deliveryMode` field: `'verbatim' | 'template' | 'llm'` (default `'llm'`).
- **FR-002**: verbatim mode — literal text output, zero LLM call, no modification.
- **FR-003**: template mode — `{{variable}}` substitution from conversation slots, zero LLM call.
- **FR-004**: llm mode — fragment content = system instruction for LLM generation (current behavior).

### Переменные

- **FR-005**: variable parser `\{\{(\w+)\}\}` — extracts variable names from fragment text.
- **FR-006**: variable resolution order: conversation.slots → conversation.context → RAG metadata → global defaults.
- **FR-007**: unclosed variable → `[уточнить]` placeholder + warning log.

### Адаптивное интро

- **FR-008**: `fragment.adaptiveIntro` boolean (default false). When true — pre-generation LLM call (lightweight model) produces 1-sentence bridge. **Промпт для интро должен явно поощрять**: разговорные частицы (ну, же, ведь, короче, слушай), нижний регистр для коротких фраз, опускание подлежащего («Пойду уточню» вместо «Я пойду уточню»), инверсию порядка слов для смыслового акцента. Это не «опция тона» — это структурное требование к intro-промпту. **Failure mode (review fix C-F4)**: intro LLM failure → graceful skip (fragment delivered without intro, warning logged). Intro is enrichment, not critical path. **Model selection (review fix C-F7)**: uses assistant's BYOK provider with fast-tier model if configured (011 model-tiering); if no fast tier → main model (fallback).
- **FR-009**: intro is prepended to fragment delivery. Verbatim/template fragments skip intro.

### Извлечение слотов

- **FR-010**: post-turn slot extraction: after each assistant reply, LLM extracts structured data per slot definitions. Выполняется **синхронно в рамках обработки хода — после генерации ответа (может идти параллельно с отправкой), но до пометки turn done** — чтобы guard requiredSlots (FR-013) на следующем ходе видел свежие слоты (clarif. 2026-06-18). Не добавляет user-facing latency. **Extraction runs against ALL slot definitions in the funnel config** (не per-stage — это закрывает anytime-trigger race: если anytime переключил stage mid-turn, extraction всё равно покрывает слоты нового stage) (review fix C-F2).
- **FR-011**: slot definitions from funnel config: `{ name, description, locked?, enum?, required? }`.
- **FR-012**: extraction writes to `conversations.slots` JSONB (Drizzle). **Concurrency model (review fix C-F3/Codex-F4)**: extraction acquire conversation-level lock (Redis `SET NX` or DB `SELECT FOR UPDATE`) before writing. Write = **JSONB merge** (`slots || new_values`, not full overwrite) — preserves concurrent slot updates from different sources. Locked slots (`slot.locked=true`) are never overwritten after first fill — enforced at DB write time (not just in extraction service). Double-send (two rapid messages) → second extraction waits for lock → merges non-overlapping slots.

### Guards

- **FR-013**: premature transition guard: before `advanceStage()` → check `stage.requiredSlots[]` all filled. Unfilled → stay + prompt.
- **FR-014**: `stage.requiresConfirmation` → confirmation prompt before advance (with slot values).
- **FR-015**: `stage.isAnytime` → can be triggered from any stage; LIFO return stack (max 3). **Full LIFO semantics (review fix Codex-F3)**:
  - **Trigger ordering**: anytime stages evaluated in `order` field (deterministic). First match wins.
  - **Self-trigger**: if current stage is anytime and re-triggers → **no-op** (skip, stay on current).
  - **Duplicate prevention**: same stage ID already in returnStack → no-op (don't push duplicate).
  - **Pop criteria**: anytime stage resolves when its `resolutionCriteria` is met (same as normal stages).
  - **Stale stage**: if popped stageId no longer exists (deleted) → pop again (skip missing), log warning.
  - **Nested**: anytime-inside-anytime → push both to stack (max 3, 4th → reject + stay on current + log).
  - **Return target**: stage ID (not snapshot). Conversation state (slots, turn count) preserved across push/pop.

### Anti-repeat & пересказ

- **FR-016**: anti-repeat — embed current + previous reply using **existing BGE-M3 embeddings** (review fix C-F8 — no new model); cosine > 0.85 → rerun with anti-repeat prompt (max 1 rerun, **в рамках глобального капа FR-026**).
- **FR-017**: contextual retelling — on stage revisit, LLM reformulates fragment (except verbatim).

### Delivery conditions

- **FR-018**: `fragment.deliveryCondition` JSONB — evaluated before scoring; non-matching excluded.

### Slots advanced

- **FR-019**: `slot.locked` — skip extraction on locked slots. **Enforced at DB write time** (not just in extraction service) — review fix C-F3.
- **FR-020**: `slot.enum[]` — extraction limited to enum values; invalid → null + retry.

### Template safety (review fix Codex-F5)

- **FR-018a**: template mode variable values are **text-escaped** before injection. Slot values containing Markdown/HTML metacharacters (`*`, `_`, `[`, `<`, `&`) are escaped per channel adapter context. URL-type slots (mediaUrl) validated against allowlist. No raw user input injected into Telegram MarkdownV2 or HTML without escaping.

### Гуманизация

- **FR-021**: banned words — per-funnel `config.bannedWords: { hard: regex[], soft: keyword[] }`. Hard → block + retry. Soft → warn + log.
- **FR-022**: output guard — post-generation filter: scan reply for hard-banned patterns → retry (max 2, **в рамках глобального капа FR-026**) → fallback handoff.
- **FR-023**: pacing metadata — **canonical shape per `contracts/metadata.md`** (review fix Codex-F1): `response.metadata.humanization.delay_ms` (reply length × ms_per_char + base + sentiment factor); `response.metadata.humanization.typing_chunks` (array of text chunks with per-chunk delay for typing animation). **Metadata может включать `response.metadata.humanization.backspace_simulation`** (review fix C-F5 — simplified to directive): `{ chance: number, enabled: boolean }` — адаптер сам решает где имитировать опечатку (1% шанс → соседняя клавиша → пауза → backspace → правильный символ). Адаптеры применяют физически; Engine только рекомендует. **Bounds (review fix Codex-F6)**: `delay_ms` clamped to [500, 8000] ms; max 10 `typing_chunks`; chunk size max 500 chars; grapheme-aware length (Intl.Segmenter).
- **FR-024**: affirmative advance — **гибрид**: regex/keyword fast-path → LLM-фолбек при неоднозначности (clarif. 2026-06-18; LLM-фолбек в рамках капа FR-026) → auto-advance on pending proposal.

### Медиа

- **FR-025**: `fragment.mediaUrl` — image URL. Engine returns `response.metadata.media[]` (canonical nested shape per `contracts/metadata.md`). Channel adapter attaches.

### Композиция и бюджет (clarif. 2026-06-18)

- **FR-026**: пост-генеративные шаги выполняются в **фиксированном порядке**: adaptive intro (pre-gen) → main generation → premature/confirmation guards → output guard / banned-words → anti-repeat → contextual retell. **Двухуровневый бюджет (review fix C-F1/Codex-F2)**:
  - `maxTurnReruns` (дефолт `2`) — кап ретраев/рерайтов (banned-words retry, anti-repeat rerun, contextual retell). При исчерпании — fail-safe (best-effort send или handoff).
  - `maxTurnLLMCalls` (дефолт `6`) — **общий** кап всех LLM-вызовов на ход (intro + main gen + guards + anti-repeat + extraction + intent fallback). При исчерпании — skip необязательных шагов (intro, anti-repeat) и доставка best-effort.
  - **Параллелизация**: adaptive intro и main generation могут запускаться **параллельно** (intro не зависит от gen output). Slot extraction и intent fallback также параллельны основному пайплайну (запускаются после reply-sent, до turn-done). Только guards (banned/anti-repeat) строго последовательны. Это снижает worst-case latency с 6×sequential до ~3×sequential.
  - Intent/trigger LLM-фолбеки (FR-015/FR-024) считаются в `maxTurnLLMCalls`, но не в `maxTurnReruns`. Slot extraction (FR-010) считается в `maxTurnLLMCalls`, но не в `maxTurnReruns` (one-shot).
  - NFR-6 метрики: `llm_calls_total`, `llm_cost_total`, `reruns_used`, `reruns_max`, `llm_calls_max`, `pipeline_step` (which step fired/skipped).

## 5. Нефункциональные требования

- **NFR-1 (perf)**: verbatim/template modes — p95 < 50ms (zero LLM). LLM modes — p95 < 3s (existing). Intro generation — p95 < 1s (lightweight model).
- **NFR-2 (надёжность)**: extraction failure → slots unchanged, reply sent normally (graceful). Banned-word retry exhausted → handoff signal, not crash.
- **NFR-3 (изолация)**: all features scoped by tenantId (existing pattern).
- **NFR-4 (backward compat)**: existing funnels without new fields → default behavior (`deliveryMode: 'llm'`, no variables, no intro, no guards). Zero regression.
- **NFR-5 (тест)**: unit tests for cascade (3 modes), variable parser, banned-word filter, pacing calculator, slot extraction. **Plus backward-compat regression E2E** (review fix Codex-F7): existing 003 funnel (no new fields) → runs identically (`deliveryMode: 'llm'`, no intro, no guards, unchanged metadata).
- **NFR-6 (наблюдаемость, clarif. 2026-06-18)**: каждый новый генеративный путь эмитит метрики — per-feature firing counts (intro / extraction / anti-repeat / banned / retell / intent-fallback), **total LLM calls per turn** (`llm_calls_total`, review fix C-F1), **total cost per turn** (`llm_cost_total`), rerun/retry counts (vs `maxTurnReruns` AND vs `maxTurnLLMCalls`), какой guard сработал/откатил/ушёл в fail-safe, какой pipeline step был skipped. Счётчики без сэмплинга; стоимость доп. вызовов — в существующий usage-учёт (007).
- **NFR-7 (PII retention, review fix C-F6)**: `conversations.slots` may contain PII (phone, email, name). Retention = conversation TTL (deleted/archived together with conversation). Access: RBAC-controlled (owner/admin only, same as conversation messages). No separate slot export without conversation context.

## 6. Краевые случаи

- Verbatim fragment with `{{variable}}` → variable NOT substituted (verbatim = literal, even with braces).
- All fragments in stage are verbatim, but user asks off-script → `offScriptBehavior: 'steer'` still works (steer generates free-form).
- Variable `{{slot_name}}` but slot not yet filled → `[уточнить]` → bot asks user for value.
- Banned word in verbatim fragment → hard block fires → but verbatim is literal! Decision: **banned words do NOT apply to verbatim** (author is responsible for content).
- Anytime stage triggered while inside another anytime → push to stack (max 3, 4th → reject + log).
- Anti-repeat with verbatim → skip (verbatim is always same text by design).
- Extraction LLM returns garbage → validate against slot schema; invalid → null (don't save garbage).
- Pacing delay_ms = 0 (short reply) → channel adapter may skip delay.

## 7. Ключевые сущности

- **Fragment** (extended): `deliveryMode`, `adaptiveIntro`, `mediaUrl`, `deliveryCondition`.
- **Stage** (extended): `requiredSlots[]`, `requiresConfirmation`, `isAnytime`.
- **Slot** (extended): `locked`, `enum[]`.
- **Conversation state** (extended): `slots` JSONB, `funnelState.returnStack[]`.
- **Response metadata** (new): `delay_ms`, `typing_chunks`, `media[]`, `blocked_by_guard`.

## 8. Зависимости и допущения

- **003-script-funnels** — base funnel runtime (stages, fragments, scoring). All extensions layer on top.
- **017-hybrid-agent-core** — original design spec; this spec implements its unimplemented features.
- **019-feedback-loop-closure** — feedback_memories (used by existing LLM mode, not changed).
- **Channel adapters** — must consume `response.metadata.delay_ms` and `response.media[]`. Each adapter (Telegram, Avito, etc.) implements physical delay + media attachment.
- **LLM client** — existing `LLMClient.complete()` for intro generation, slot extraction, anti-repeat rerun.

## 9. Success Criteria

- **SC-001**: verbatim fragment → client receives exact text, zero LLM cost, p95 < 50ms.
- **SC-002**: template fragment with `{{price}}` → price substituted from slot, zero LLM cost.
- **SC-003**: slot extraction → phone number saved to conversation.slots after user mentions it.
- **SC-004**: banned phrase «я языковая модель» → blocked, retry, clean reply or handoff.
- **SC-005**: pacing → response includes `delay_ms: 2500` for a 200-char reply.
- **SC-006**: anytime stage triggered → processes → returns to original stage.
- **SC-007**: backward compat — existing funnels work identically (all new fields default to off).

## 10. Out of Scope

- UI редактор (Product `025-funnel-editor-richness`).
- DSPy pipeline (requires Python + training data).
- External memory platforms (Mem0, Letta, EverOS).
- Model distillation (S2T, CRAG, Self-RAG).
- Conversation analyzer (024 adaptive-onboarding).
- Multi-agent debate pipeline (Generator → Critic → Synthesizer).

## 11. Глоссарий

- **Каскад** — порядок доставки: verbatim (дословно) → template (переменные) → LLM (генерация).
- **Verbatim** — фрагмент отправляется как есть, без LLM. Для критических фраз.
- **Template** — фрагмент с подстановкой переменных, без LLM.
- **Adaptive intro** — LLM-генерируемый мостик (1 предложение) перед фрагментом.
- **Slot extraction** — извлечение структурированных данных из сообщения пользователя.
- **Anytime stage** — этап, доступный из любого места воронки по триггеру.
- **Banned words** — запрещённые слова/фразы: hard (блок) / soft (предупреждение).
- **Pacing** — рекомендованная задержка перед отправкой ответа (имитация человеческого темпа).
- **Delivery condition** — фильтр фрагментов по значениям слотов.
