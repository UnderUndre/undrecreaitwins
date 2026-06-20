# Feature Specification: Language Guard — LLM Rewrite Remediation + Language Mirroring

**Feature Slug**: `024-language-guard-rewrite-mirror`
**Repo**: `undrecreaitwins` (Engine)
**Created**: 2026-06-20
**Status**: Clarified (post-review fixes applied 2026-06-20)
**Input**: Brainstorm 2026-06-20 (rewrite-vs-strip + mirror-user-language). Phase 2 of language guard. Builds on `017-language-guard-validator` (validator runtime) + `023-language-guard-validator-leftovers` (config API).

## 1. Описание

Phase 1 (017) language-guard чинит off-language ответы детерминированно: `strip` (вырезать инородные символы → часто мусор/пусто) или `block` (заменить на канцелярский фолбэк). Для UX это слабо. Phase 2 меняет **remediation** на **LLM-перевод/переписывание** ответа в целевой язык, и добавляет **выбор целевого языка по языку юзера** (mirror): если персоне разрешено несколько языков — отвечаем на том, на котором написал клиент (в пределах allowed).

Это **рантайм-изменение валидатора** (017 §10 объявлял рантайм out-of-scope — 024 это сознательно переоткрывает; см. Clarifications). Валидатор сейчас **без LLM**; 024 добавляет ему LLM-зависимости (langid + переводчик) и эскалацию на основную модель.

**Тиерная remediation (A+B, решено в брейншторме):**
1. **Директива** (динамическая, $0): системный промпт → «отвечай на {target}».
2. **Детект** (скрипт + langid, дёшево): ответ в target?
3. **Translate-pass** (платформенная мелкая модель, только на нарушении): перевести `answer` в target.
4. **Regenerate-эскалация** (основная модель, если перевод провалил fidelity): один перегенер.
5. **strip/block** (Phase 1) — аварийный фолбэк, если 3-4 упали/таймаут.

**Target-selection:** `target = langid(user_msg) ∈ allowed ? langid(user_msg) : fallbackLanguage`. Один allowed → пин (langid не зовётся). Несколько → mirror через langid.

## Clarifications

### Session 2026-06-20 (brainstorm lock-ins)

- **Q: Remediation — translate, regenerate, или оба?** → A: **Оба (A+B), тиерно.** Translate-pass дешёвой моделью на нарушении; если перевод не проходит fidelity-чек → эскалация на regenerate основной моделью (1 попытка); если и это упало → strip/block (Phase 1). strip/block больше не основное лечение, а последний резерв.
- **Q: Inbound language detection (для mirror) — скрипт, langid-либа или LLM?** → A: **Дешёвый LLM** (точность важнее цены). ⚠️ Cost: langid-вызов нужен на КАЖДОЕ инбаунд-сообщение **только в mirror-режиме** (allowedLanguages.length > 1). Single-language персона → langid не зовётся ($0). Accepted: multi-language персоны платят +1 дешёвый вызов/сообщение.
- **Q: Translate-модель — BYOK тенанта или платформенная?** → A: **Платформенная мелкая модель** (перевод не BYOK-чувствителен; не тратим ключ тенанта). Зафиксировать модель в конфиге движка, не per-persona.
- **Q: Streaming + post-hoc remediation?** → A: **Guard-активные персоны доставляют буферизованно (стрим выключен).** Нельзя провалидировать/перевести, не имея полного текста — детект и translate происходят ПОСЛЕ генерации. Уточнение к брейншторм-формулировке «стрим off на violation»: физически off-on-violation невозможен (нарушение известно только после полной генерации, к этому моменту стрим уже ушёл бы), поэтому правило = **guard active (enabled + allowedLanguages непустой) ⇒ buffered delivery**. Happy-path тоже буферизуется (цена выключенного стрима — осознанный трейд за корректность).
- **Q: Scope — A+B сразу или поэтапно?** → A: **A+B в одном цикле.**

### Session 2026-06-20 (review fixes — F2, F4, F6, F9, F11, F12, F13, F14)

- **F2 (agentic-path)**: Решено — **agentic-answer прогоняется через language-guard remediation** (directive + detect + translate/regenerate). Принцип: языковое поведение должно быть консистентно между chat и agentic. Agentic-ветка chat-service теперь вызовет remediation pipeline перед отдачей answer. Если remediation упала/таймаут → answer отдаётся как есть (деградация), с audit-записью `remediation: 'degraded'`.
- **F4 (fidelity scope)**: Narrowed: fidelity-guard покрывает **числа/код-блоки/URL/currency-symbols** (structural compare). Имена/даты/произвольные факты НЕ покрываются structural compare. Дополнительно: **placeholder-masking** перед translate — числа, цены, даты, URL, код заменяются на токены (`__NUM0__`, `__PRICE1__`, `__DATE0__`, `__URL0__`, `__CODE0__`), восстановление verbatim после. Двойная защита: masking (гарантия) + structural compare (страховка).
- **F6 (same-script outbound)**: Разделены два gate: **inbound-mirror langid** (cost-gated: `targetPolicy='mirror' AND allowed>1`) vs **outbound same-script detection langid** (`LANG_GUARD_LANGID_MODEL`, вызывается когда script-detector detects same-script pair target↔response, включая single-language персоны). SC-006 ($0 happy-path) сохраняется — outbound detect на happy-path не нужен (ответ уже в target). Cost: outbound langid только на детектированном нарушении, не на каждое сообщение.
- **F9 (injection)**: langid output **parse+validate** до строгого BCP-47 code из supported set перед интерполяцией в directive. Никогда raw langid text в system prompt. Translate prompt **fences** user/answer content. FR-001 check = strict equality (`langid === 'en'`), не `includes`.
- **F11 (number formatting)**: Числа — locale-invariant. Translate prompt: «preserve all numbers and formatting exactly as-is, including decimal separators». Structural compare на numeric value (parseFloat), не string equality.
- **F12 (sticky target)**: **Дроп sticky.** Low-confidence langid → fallbackLanguage (проще, не требует session state).
- **F13 (config validation)**: Правила: (a) `fallbackLanguage ∈ allowedLanguages` (иначе 400 на PUT); (b) `targetPolicy='fixed'` без `fixedLanguage` → 400; (c) `allowed.length==1` игнорирует `targetPolicy` (всегда pin); (d) `fixedLanguage` с `targetPolicy='mirror'` → игнорируется + warning в audit.
- **F14 (funnel malformed)**: Detection target = parsed `answer` field only. Если funnel envelope malformed (JSON parse fail) → detection пропускается, remediation не зовётся, answer отдаётся как есть (audit: `remediation: 'skipped'`, reason: `funnel_malformed`).

## 2. Границы

**Это**: рантайм-изменения `LanguageGuardValidator` + chat-service: динамическая директива, target-resolution (mirror/fixed + langid), translate-pass remediation, regenerate-эскалация, buffered delivery когда guard активен, конфиг-поля для всего этого, расширение audit (тип remediation + source/target lang). Расширение supported-language set.

**Это НЕ**: Config CRUD API (спека 023). Product UI (спека 026, Phase 2 раздел). strip/block-механика (017, переиспользуется как фолбэк). Per-task LLM-роутинг в общем виде (это локальный выбор: langid+translate = платформенные модели).

## 3. Пользовательские истории

### US-1 — Перевод вместо вырезания (P1)
Ассистент с allowed=['en'] выдал ответ с китайскими фразами. Вместо strip (мусор) система переводит ответ на английский и отдаёт связный текст.
- **AC**: off-target ответ → translate-pass → клиент получает связный ответ на target. Audit фиксирует `remediation: 'translated'`, `sourceLang`, `targetLang`. Факты/числа/имена сохранены (см. fidelity, FR-005).

### US-2 — Ответ на языке клиента (mirror, P1)
Персона allowed=['ru','en']. Клиент пишет по-английски → бот отвечает по-английски. Тот же клиент потом пишет по-русски → бот отвечает по-русски.
- **AC**: langid инбаунда → target ∈ allowed → директива «respond in {target}». Переключение в пределах диалога работает per-message. allowed.length==1 → langid не зовётся, пин на единственный.

### US-3 — Клиент пишет на неразрешённом языке (P1)
allowed=['ru','en'], клиент пишет по-французски.
- **AC**: langid='fr' ∉ allowed → target = `fallbackLanguage` (конфиг; дефолт = первый allowed). Бот отвечает на fallback, не на fr.

### US-4 — Эскалация на regenerate при провале перевода (P2)
Перевод исказил тон/факты (fidelity-чек не прошёл) → система перегенерирует основной моделью с усиленной директивой.
- **AC**: translate fidelity fail → 1 regenerate основной моделью → повторный детект; если ок — отдать; если нет — strip/block фолбэк. Не более 1 regenerate (cost guard).

### US-5 — Деградация при сбое LLM (P1)
langid или translate-модель упала/таймаут.
- **AC**: langid fail → деградация на script-only детект + fixed target (default); mirror отключается для этого сообщения, не блок. translate fail/timeout → regenerate или strip/block. Цепочка никогда не висит и не роняет ответ.

## 4. Функциональные требования

- **FR-001 (target resolution)**: Engine резолвит target-язык per-message. `targetPolicy: 'mirror' | 'fixed'`. `fixed` → target = `fixedLanguage` (или единственный allowed). `mirror` → `langid(inbound) ∈ allowed ? langid : fallbackLanguage`. allowed.length==1 ⇒ всегда pin, langid не вызывается.
- **FR-002 (langid)**: inbound language detection через **платформенную дешёвую LLM-модель** (`LANG_GUARD_LANGID_MODEL` env). Вызывается ТОЛЬКО при `targetPolicy='mirror'` AND `allowedLanguages.length > 1`. Возвращает **structured output** `{lang: BCP47, confidence: float}` (constrained decoding, не free-text). Output **parse+validate** до strict BCP-47 из supported set перед использованием. Таймаут (env, дефолт 3s) → деградация (FR-009).
- **FR-002b (outbound same-script detect)**: для outbound detect — если script-based detector определяет same-script pair (target и response в одном скрипте, напр. en↔de — оба Latin), вызывается `LANG_GUARD_LANGID_MODEL` для точного детекта. Работает для **всех** персон (включая single-language), но **только на детектированном нарушении** (не на каждом ответе). Cost: $0 на happy-path (нет нарушения → нет вызова).
- **FR-003 (dynamic directive)**: `buildLanguageDirective` принимает резолвленный `target` (не статичный список): «respond ONLY in {targetName}». Инжектится в system prompt (gated `enabled !== false`, как 023 FR-003). Заменяет текущую статичную директиву.
- **FR-004 (outbound detect)**: после генерации — детект языка ответа: скрипт (Phase 1) + langid для same-script кейсов (когда target и detected в одном скрипте, напр. en/de — оба Latin). Нарушение = ответ не в target.
- **FR-005 (translate-pass remediation)**: на нарушении — **платформенная мелкая модель** (`LANG_GUARD_TRANSLATE_MODEL` env) переводит ответ в target. **Только `answer`** (для funnel-конверта `{answer, stage_transition, slots}` — stage/slots не трогать). Промпт переводчика: «translate to {target}, preserve ALL facts, numbers, prices, names, formatting and code blocks verbatim; do not add or remove content». **Placeholder-masking** перед translate: числа, цены, даты, URL, код заменяются на токены (`__NUM0__`, `__PRICE1__`, `__DATE0__`, `__URL0__`, `__CODE0__`), восстановление verbatim после translate. Fidelity-guard: structural compare (numbers по numeric value, code-blocks, URLs, currency symbols) до и после; расхождение → fidelity fail → FR-006. User/answer content **fenced** в translate prompt.
- **FR-006 (regenerate escalation)**: translate fidelity fail → **1** regenerate основной моделью (реюз LLM-клиента, усиленная директива + «прошлый ответ был на неверном языке»). maxRegenerate=1 (cost guard). Повторный детект; fail → FR-007.
- **FR-007 (last-resort fallback)**: translate+regenerate оба провалились/таймаут → Phase 1 strip/block (по thresholds). Гарантирует, что ответ всегда уходит.
- **FR-008 (buffered delivery)**: когда guard активен (`enabled && allowedLanguages непустой`) — доставка **буферизованная** (стрим выключен): полный ответ генерируется, детектится, ремедиируется, ТОЛЬКО потом отправляется в канал. Стрим остаётся только для guard-неактивных персон.
- **FR-009 (graceful degradation)**: langid fail/timeout → script-only детект + fixed target (default), mirror skip для сообщения. translate fail/timeout → FR-006. Любой LLM-сбой в цепочке логируется, ответ доставляется (никогда не висит).
- **FR-010 (supported languages)**: расширить `BCP47_TO_SCRIPTS` (сейчас 9: ru/en/zh/ar/hi/he/th/ko/ja) до **явного набора**: исходные 9 + СНГ-языки — `kk` (казахский), `uk` (украинский), `uz` (узбекский), `ky` (киргизский), `hy` (армянский), `ka` (грузинский), `az` (азербайджанский), `be` (белорусский), `tg` (таджикский), `mo` (молдавский). Итоговый набор = **19 языков**. Source-of-truth — единый экспорт `BCP47_TO_SCRIPTS`, который 023 FR-005 и 026 multi-select импортируют (закрывает рассинхрон). Язык вне набора в config → 400 на PUT (023), не silent-zero-scripts.
- **FR-011 (config additions)**: `LanguageGuardConfig` += `targetPolicy: 'mirror'|'fixed'` (default `'mirror'` если allowed>1, иначе irrelevant), `fixedLanguage?: string`, `fallbackLanguage: string` (default = allowed[0]), `remediation: 'translate'|'strip-block'` (default `'strip-block'` для backward-compat — NFR-5; `strip-block` = Phase 1 поведение для тех, кто не хочет LLM-стоимость), `langidMinConfidence?: number` (default 0.7 — порог ниже которого langid считается ненадёжным → fallbackLanguage). Хранится в JSONB config (как остальные поля 017). **Config validation** (extends 023 PUT): (a) `fallbackLanguage ∈ allowedLanguages` (иначе 400); (b) `targetPolicy='fixed'` без `fixedLanguage` → 400; (c) `allowed.length==1` игнорирует `targetPolicy` (всегда pin); (d) `fixedLanguage` с `targetPolicy='mirror'` → warning в audit, поле игнорируется.
- **FR-012 (audit)**: `validator_runs` для language-guard логирует `remediation` тип (`translated|regenerated|stripped|blocked|pass`), `sourceLang`, `targetLang` в metadata (расширяет 023 audit-маппинг). Стоимость (langid+translate вызовы) — в observability-метрики.
- **FR-013 (agentic-path coverage)**: **РЕШЕНО (review F2)** — agentic-answer **прогоняется через** language-guard remediation (directive + detect + translate/regenerate). Принцип: языковое поведение консистентно между chat и agentic. Agentic-ветка chat-service вызывает remediation pipeline перед отдачей answer. Если remediation упала/таймаут → answer отдаётся как есть (деградация), audit: `remediation: 'degraded'`.

## 5. Нефункциональные требования

- **NFR-1 (cost)**: single-language персона → $0 доп-вызовов на happy-path (директива). mirror-персона → +1 langid/сообщение (дешёвая модель). Перевод/regenerate — только на нарушении. Жёсткие cost-guards: maxRegenerate=1, без рекурсии translate→translate.
- **NFR-2 (latency)**: langid < 1s (дешёвая модель, короткий промпт); translate-pass < 3s; буферизация добавляет полную генерацию к TTFB (стрим off) — приемлемо для guard-персон. **Latency budget (review F7)**: `generation_ms + langid_ms + detect_ms + translate_ms + fidelity_ms ≤ min(AGENT_MAX_EXECUTION_MS, channel_ack_timeout)`. Worst-case remediation path = 2× main-model generation + 2 platform calls. Если remediation превысит бюджет → **skip regenerate**, сразу strip/block (FR-007). Предотвращает fallback поверх remediation (wasted spend) и dropped messages. Конкретные значения — из env config + измерений в T0.
- **NFR-3 (fidelity)**: переводчик НЕ меняет числа/цены/код/URL. **Двойная защита**: (1) placeholder-masking перед translate — гарантия сохранения критичных токенов; (2) structural compare (numbers по numeric value, code-blocks, URLs, currency symbols) до/после. Имена/даты/произвольные факты НЕ покрываются structural compare (ограничение; masking покрывает даты). Расхождение → regenerate, не отдавать искажённый перевод (критично для прайсов — продажный бот не должен «перевести» цену в другую).
- **NFR-4 (изоляция)**: langid/translate вызовы — платформенные модели, но контекст (текст юзера/ответа) tenant-scoped; не логировать содержимое в plaintext-метрики (PII). **Data governance (review F5)**: для BYOK-тенантов, выбравших provider по data-residency/DPA причинам — routing к платформенной модели должен быть **opt-in** через config (`allowPlatformModelRouting: boolean`, default `false` для backward-compat). При `false` + `remediation='translate'` → guard падает на strip-block (Phase 1), с warning в audit. Документировать в 026 UI как tenant-visible notice.
- **NFR-5 (backward compat)**: персоны без новых полей → `remediation: 'translate'` если allowed непустой? НЕТ — backward-safe дефолт = **Phase 1 поведение** (`strip-block`), чтобы существующие персоны не начали внезапно платить за LLM-перевод. Включение translate/mirror — явный opt-in через config.

## 6. Краевые случаи

- **Mixed-language inbound** (юзер пишет «привет, how much?») → langid возвращает доминирующий; tie/uncertain → fallbackLanguage.
- **Короткое сообщение** («ок», «да») → langid ненадёжен; при low-confidence (< `langidMinConfidence`, default 0.7) → fallbackLanguage. Sticky target **dropped** (не требует session state; проще и детерминированно).
- **Target вне supported set** (fallbackLanguage задан как неподдержанный) → 400 на config PUT (FR-010); рантайм-страховка → first supported allowed.
- **Funnel structured output** → переводится только `answer`; `stage_transition`/`slots` не трогаются (иначе ломается воронка). Malformed envelope (JSON parse fail) → detection skip, remediation skip, audit `remediation: 'skipped'` reason `funnel_malformed`.
- **Same-script violation** (allowed=['en'], ответ на немецком — оба Latin) → outbound same-script detect (FR-002b) ловит через langid на нарушении; translate fires. SC-006 сохраняется ($0 happy-path — нет нарушения → нет langid).
- **Перевод исказил цену/факт** → fidelity fail → regenerate; повторный fail → strip/block + fallback message (лучше канцелярит, чем неверная цена).
- **Код-блоки/ссылки в ответе** → переводчик сохраняет verbatim (как и Phase 1 detect маскирует код перед анализом).
- **langid LLM упал** → script-only + fixed default, mirror skip, не блок.
- **translate LLM упал/таймаут** → regenerate; упал → strip/block.
- **Agentic-персона** → см. FR-013 (покрыть или явно исключить с warning).
- **Streaming-канал + guard active** → буфер; клиент видит «печатает…» дольше (pacing/typing-индикатор из 017 FR-012 закрывает UX).
- **Рекурсия**: translate выдал снова off-target → НЕ translate повторно; сразу regenerate (1) → strip/block. Без бесконечного цикла.
- **Cost-бомба**: тенант шлёт спам на mirror-персону → langid на каждом; rate-limit (017/026 уровень) + дешёвая модель ограничивают урон.

## 7. Ключевые сущности

- **LanguageGuardConfig** (расширенный): 017/023 поля + `targetPolicy`, `fixedLanguage?`, `fallbackLanguage`, `remediation` (`translate|strip-block`).
- **TargetResolution**: per-message результат — `{ target: BCP47, source: 'mirror'|'fixed'|'fallback'|'degraded', langidConfidence? }`.
- **RemediationResult**: `{ type: 'pass'|'translated'|'regenerated'|'stripped'|'blocked', sourceLang, targetLang, fidelityOk }`.
- **Supported language set**: единый экспорт (`BCP47_TO_SCRIPTS` расширенный) — source-of-truth для 023 валидации и 026 UI.
- **Platform models**: `LANG_GUARD_LANGID_MODEL`, `LANG_GUARD_TRANSLATE_MODEL` (env, не BYOK).

## 8. Зависимости

- **017-language-guard-validator** (IMPLEMENTED): валидатор, скрипт-детект, strip/block, `buildLanguageDirective`, `BCP47_TO_SCRIPTS`. 024 модифицирует рантайм.
- **023-language-guard-validator-leftovers**: config API + `enabled`/`version`. 024 добавляет config-поля → 023 контракт расширяется (или 024 поля идут в JSONB, 023 их прозрачно хранит).
- **LLMClient** (IMPLEMENTED): для langid + translate + regenerate. Платформенные модели — нужен способ вызвать НЕ-BYOK модель (платформенный provider config).
- **chat-service.ts**: точка инъекции директивы (`:1010`) + место buffered delivery + agentic-path (FR-013).
- **Product 026** (Phase 2 раздел): UI для targetPolicy/fallbackLanguage/remediation. Blocked-by: эта спека.
- **017 hybrid-agent-core**: `AGENT_MAX_EXECUTION_MS` + fallback_threshold — remediation должен укладываться (NFR-2), иначе fallback выстрелит поверх.

## 9. Success Criteria

- **SC-001**: allowed=['en'], ответ с китайским → клиент получает связный английский (translated), не мусор-strip.
- **SC-002**: allowed=['ru','en'], юзер пишет en → ответ en; пишет ru → ответ ru (mirror, per-message).
- **SC-003**: юзер на неразрешённом языке → ответ на fallbackLanguage.
- **SC-004**: перевод исказил число/цену → fidelity fail → regenerate; искажённый перевод НЕ доставлен.
- **SC-005**: langid/translate сбой → ответ всё равно доставлен (деградация), не висит.
- **SC-006**: single-language персона → ноль доп-LLM-вызовов на happy-path.
- **SC-007**: guard-active персона доставляет буферизованно; off-target ответ не «протекает» в канал до remediation.
- **SC-008**: supported-set синхронизирован — язык, выбранный в 026 UI, валидатор всегда понимает (нет silent-zero-scripts).

## 10. Out of Scope

- Config CRUD HTTP API (023).
- Product UI (026 Phase 2 раздел — отдельно).
- Общий per-task LLM-роутинг (langid/translate = фиксированные платформенные модели здесь).
- Реал-тайм streaming с inline-коррекцией (буфер вместо стрима — осознанно).
- Перевод вложений/медиа (только текст `answer`).

## 11. Глоссарий

- **Mirror** — target-язык = язык инбаунд-сообщения юзера (в пределах allowed).
- **Translate-pass** — дешёвый платформенный LLM переводит off-target ответ в target (основная remediation Phase 2).
- **Regenerate-эскалация** — перегенерация основной моделью при провале fidelity перевода (1 попытка).
- **Fidelity-guard** — структурная сверка (числа/код/URL) до и после перевода; защита от искажения фактов/цен.
- **Buffered delivery** — guard-активная персона не стримит; полный ответ валидируется/ремедиируется до отправки.
- **langid** — определение языка инбаунда дешёвым платформенным LLM (только mirror + allowed>1).
