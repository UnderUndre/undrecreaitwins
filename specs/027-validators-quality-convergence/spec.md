# Feature Specification: Validators ⊕ Quality Rules — Unified Response Guard Pipeline

**Feature Slug**: `027-validators-quality-convergence`
**Repo**: `undrecreaitwins` (Engine)
**Created**: 2026-06-23
**Status**: Draft (design-only; implement gated per Constitution Principle VI)
**Input**: Pivot from product `ai-twins/028-validators-quality-rules-ui-merge` (clarify 2026-06-23). User decision: merge validators and quality rules **at the engine level** — validators become built-in *default quality rules* in one pipeline that checks **and** corrects responses. Scope confirmed via `/speckit.scope` (path **B** — thin convergence spec depending on landed 004/017/018/024). Engine counterpart of product 028 (which becomes the UI layer on top).

## 1. Описание

Сегодня движок прогоняет ответ ассистента через **два независимых пост-прохода** в `chat-service.ts`:

1. **`ValidatorPipeline.validateResponse()`** (`packages/core/src/services/validators/pipeline.ts`) — 3 детерминированных response-валидатора: `language-guard`, `false-promise`, `identity-guard` (fix F6: `format-injection` — input-валидатор, работает через `validateInput` на сообщении пользователя, а не на ответе). Дёшево ($0, без LLM на happy-path), вердикты `no_op/append_disclaimer/block/rewrite/error/strip/pass` (fix F1: реальные значения enum, не pass/strip/block/warn), лог → `validator_runs` (`verdict`+`isDryRun`+`createdAt`+`validatorName`). Режим `active|dry-run` (fix F8: language-guard + identity-guard default `dry-run`).
2. **`darExecute()`** (`packages/core/src/services/correction-rules/dar-pipeline.ts`, импорт `chat-service.ts:13`) — LLM-based Detect-Analyze-Rewrite по кастомным quality-правилам (018). Вердикты `pass/fail/rewritten/rolled_back`, лог → `QualityEvent` (`mode='018-dar-pipeline'`, `score`, `latencyMs`, `createdAt`).

Это **два пайплайна, две модели лога, два конфига** для одной по сути задачи — «проверить ответ и при нарушении исправить». Расхождения: разный словарь вердиктов, разное имя таймстампа (`runAt` vs `createdAt`), раздельные конфиги (`validator_configs` vs correction-rule storage), раздельная выдача в UI. Это и есть причина, по которой product-028 пытался свести их **в UI** костылём (normalization-adapter) — лечил симптом.

**027 сводит их в движке.** Один **tiered pipeline**: системные валидаторы = встроенные **default quality rules**, бегут первыми и дёшево; кастомные LLM-правила (DAR) — после; LLM-коррекция только на нарушении. Один унифицированный run-лог, один конфиг-контракт. Поверх этого product-028 становится тонким UI (один таб, один лог) без UI-нормализации.

Уже есть шов для конвергенции: `correction-rules/re-validator.ts` переиспользует классы валидаторов (`FalsePromise/IdentityGuard/LanguageGuard`) чтобы перепроверять переписанный текст — то есть валидаторы и коррекция **уже** делят машинерию, просто не оркестрированы в один проход.

## 2. Границы

**Это**: единый orchestration-модуль в `chat-service` (заменяет раздельные `validateResponse` + `darExecute` на один упорядоченный проход); модель «валидаторы как built-in default quality rules» (сидинг системных правил, не удаляемых оператором); унифицированный run-лог (свести `validator_runs` + `QualityEvent` к одной форме/эмиттеру); унифицированный конфиг-контракт; сохранение тиринга и cost-модели; консистентность chat ↔ agentic путей.

**Это НЕ**: product UI (это 028 — потребляет результат). BFF API ai-twins (019/026 — переиспользуются/выравниваются). Изменение алгоритмов самих валидаторов (language-guard detection и т.д. — 017/024, переиспользуются как есть). Новые типы remediation сверх существующих (translate/regenerate/strip/block из 024 + DAR rewrite из 018). Миграция БД исполняется напрямую — только `.sql` на ревью (Standing Order 5).

## 3. Пользовательские истории

### US-1 — Один проход вместо двух (P1)
Сейчас ответ проходит `validateResponse` и отдельно `darExecute`. После 027 — один `responseGuard.run()` с детерминированным упорядочиванием стадий.
- **AC**: chat-service вызывает один orchestration-вход; порядок стадий детерминирован и сконфигурирован; вердикт/коррекция каждой стадии видны в одном результате. Существующее поведение валидаторов и DAR сохранено (regression-parity).

### US-2 — Валидаторы как default quality rules (P1)
Системные валидаторы (`language-guard`, `false-promise`, `format-injection`, `identity-guard`) представлены как встроенные quality-правила: видны рядом с кастомными, конфигурируемы (on/off, mode), но **не удаляемы** (system-owned).
- **AC**: per-tenant/persona конфиг перечисляет system-правила + custom-правила в одной модели; system-правила нельзя удалить (только enable/disable/mode); сидинг идемпотентен.

### US-3 — Единый run-лог (P1)
Каждый прогон (валидатор или quality-rule) пишется в одну лог-форму с общим словарём вердиктов и общим таймстампом.
- **AC**: один эмиттер/таблица (или унифицированная проекция) `{ ts, kind: 'system'|'custom', ruleKey, verdict, ... }`; product-028 читает ОДИН источник, без UI-нормализации; обратная совместимость с историей `validator_runs`/`QualityEvent` (миграция или view).

### US-4 — Тиринг и cost сохранены (P1)
Объединение НЕ должно прогонять дешёвые детерминированные проверки через LLM.
- **AC**: на happy-path (ответ проходит детерминированные стадии) LLM-DAR/коррекция НЕ зовётся; cost-профиль персоны без custom-LLM-правил не растёт после 027 (см. NFR-1).

## Clarifications

### Session 2026-06-23

- **Origin**: переоткрыто из product-028 clarify. Решение: мердж на уровне движка, один tiered pipeline (а не UI-нормализация). См. `ai-twins/specs/028.../spec.md` Clarifications 2026-06-23 + `ai-twins/specs/_overlap.md`.
- **Grounding (re-verified against live code 2026-06-23, review fix F1/F6)**: два прохода в `chat-service.ts` — `validatorPipeline.validateResponse` (3 response-валидатора: language-guard, false-promise, identity-guard; format-injection — input-валидатор через `validateInput`) + `darExecute` (`correction-rules/dar-pipeline.ts`, DAR/018). `re-validator.ts` переиспользует классы валидаторов. Логи раздельные: `validator_runs` (verdict enum: no_op/append_disclaimer/block/rewrite/error/strip/pass; isDryRun; validatorName; createdAt) vs `QualityEvent` (verdict/createdAt, mode `018-dar-pipeline`). `validateResponse` возвращает `Promise<string>` (не объект).
- **Q: Re-architect или build-on?** → A: **Build-on (path B).** Обобщить `ValidatorPipeline` (валидаторы = стадии), DAR — стадия после детерминированных; не форкать и не переписывать chat-service с нуля.
- **Q: Тиринг?** → A: **Обязателен.** Детерминированные стадии первыми и дёшево; LLM-коррекция только на нарушении (cost-модель 024 сохраняется).
- **Q: Координация с 027-product (Zod SOT)?** → A: 027-engine **меняет форму** `ValidatorRun`/`QualityEvent` (унификация лога), а product-027 хочет их заморозить. **027-engine идёт первым**; product-027 морозит уже унифицированные типы. Зафиксировать в обоих.
- **Q (cross-DB log, verified in code)**: `validator_runs` живёт в **engine** Postgres (Drizzle `pgTable`, `models/validators.ts`), `QualityEvent` — в **BFF** Postgres (ai-twins Prisma), питается из engine `QualityEventPush` (`dar-pipeline.ts:90`). Две БД, две репы → DB-view union невозможен. Как свести в один лог? → A: **Валидаторы тоже эмитят `QualityEventPush`** (`kind='system'`) рядом с DAR (`kind='custom'`); всё течёт по существующему engine→BFF push-каналу в ОДНУ унифицированную BFF-таблицу. Нормализация — один раз, на эмите. `validator_runs` → engine-internal/deprecated. Это и есть «валидаторы = default quality rules» на уровне данных.
- **Q (cross-DB config)**: Конфиг тоже split — engine `validator_configs` (Drizzle) + BFF `ValidatorConfig` (Prisma, 026) для валидаторов; BFF `CorrectionRule` (Prisma) → engine `rule-cache` через `correction-rules-reload`. Где единый rule-store? → A: **BFF владеет единым rule-store.** System-валидаторы засеяны как `kind='system'`-строки рядом с custom; существующий reload-push расширяется нести system+custom в engine `rule-cache`. Engine `validator_configs` → cache/проекция от push, не SOT. Зеркало Q1: логи engine→BFF, конфиг BFF→engine.
- **Q (precedence/short-circuit)**: Когда детерминированный валидатор даёт terminal-вердикт (`block`), пайплайн останавливается до LLM-стадий или гонит всё? → A: **Per-rule конфигурируемо** — у каждого правила (system + custom) флаг `terminalOnFail`. На fail с `terminalOnFail=true` пайплайн short-circuit'ит (пропускает остаток). **Дефолты для cost-safety (NFR-1)**: `block`-валидаторы → `terminalOnFail=true`; `warn`/`strip`/custom → `false`. Лог фиксирует, какое правило оборвало проход (`shortCircuitedBy`).
- **Q (verdict granularity)**: Схлопывать все коррекции в `corrected` или хранить подтип? → A: **Coarse + detail.** `verdict ∈ {pass,block,warn,corrected}` (фильтруемое, для 028/дашбордов) + `detail` с нативным подтипом (`translated/regenerated/rewritten/rolled_back/stripped/degraded/skipped`). 028 фильтрует по `verdict`, аудит читает `detail`. Маппинг old→coarse+detail в движке на эмите.

## 4. Requirements

### Functional Requirements

- **FR-001 (Orchestration module)**: Движок ДОЛЖЕН предоставить единый вход `responseGuard.run(response, ctx)` в `chat-service`, заменяющий раздельные `validatorPipeline.validateResponse()` + `darExecute()`. Все три call-site `validateResponse` (chat happy-path, buffered-delivery, agentic) ДОЛЖНЫ идти через него.
- **FR-002 (Tiered stage order + per-rule terminal)**: Pipeline ДОЛЖЕН исполнять стадии в детерминированном порядке: детерминированные валидаторы (дёшево) → при нарушении/необходимости LLM-стадии (DAR rewrite, translate/regenerate из 024) → re-validate переписанного (переиспользуя `re-validator.ts`) → фолбэк strip/block. Каждое правило несёт флаг **`terminalOnFail`**: при fail с `terminalOnFail=true` пайплайн short-circuit'ит (остаток стадий пропускается), результат фиксирует `shortCircuitedBy`. **Дефолты (cost-safety, NFR-1)**: `block`-валидаторы → `true`; `warn`/`strip`/custom → `false`. Порядок стадий конфигурируем.
- **FR-003 (Validators as default rules)**: Системные валидаторы ДОЛЖНЫ быть представлены как built-in quality-правила в единой конфиг-модели: enable/disable/mode на tenant/persona, но НЕ удаляемы. Сидинг идемпотентен.
- **FR-004 (Unified run-log)**: Каждая стадия ДОЛЖНА эмитить единую лог-форму `{ ts, kind: 'system'|'custom', ruleKey, verdict ∈ {pass,block,warn,corrected}, detail?, shortCircuitedBy?, sourceLang?, targetLang?, score?, latencyMs?, conversationId, messageId? }`. `verdict` — coarse (фильтруемое); `detail` — нативный подтип (`translated/regenerated/rewritten/rolled_back/stripped/degraded/skipped`). Маппинг реальных вердиктов `validator_runs.verdict` (enum: `no_op/append_disclaimer/block/rewrite/error/strip/pass` + `isDryRun`) и DAR (`pass/fail/rewritten/rolled_back`) в `verdict`+`detail` — в движке на эмите (НЕ в UI). См. data-model.md §3.1 для полной маппинг-таблицы.
- **FR-005 (Unified config store, BFF-owned)**: BFF владеет единым rule-store (system-валидаторы как `kind='system'`-строки + custom-правила). Существующий BFF→engine push (`correction-rules-reload` → расширить до `rules-reload`) несёт system+custom в engine `rule-cache`; engine `validator_configs` становится cache/проекцией, не SOT. Версионирование сохранено (`version integer` + `snapshotVersion` rule-cache). System-правила не удаляемы (FR-003).
- **FR-006 (Unified log via push, not view)**: Валидаторы ДОЛЖНЫ эмитить `QualityEventPush` (`kind='system'`) в существующий engine→BFF push-канал (`dar-pipeline.ts` уже строит `QualityEventPush[]`); BFF персистит system+custom в ОДНУ таблицу, которую читает product-028. **Cross-DB view невозможен** (`validator_runs` в engine Postgres, `QualityEvent` в BFF Postgres). `validator_runs` → engine-internal/deprecated. Историческая совместимость: backfill старых `validator_runs` в унифицированную BFF-таблицу — `.sql` на ревью (FR-008), либо read-time merge на переходный период.
- **FR-007 (Path consistency + per-call-site tier)**: chat и agentic пути ДОЛЖНЫ идти через один `responseGuard.run`. **fix F7**: Guard tiers (deterministic-only vs deterministic+LLM) конфигурируются per-call-site — agentic/buffered могут opt-in в deterministic-only tier, чтобы избежать непредвиденных LLM-вызовов (DAR сегодня работает только на happy-path `chat-service.ts:481`; добавление ко всем 3 путям = новая cost/behavior поверхность). Матрица call-site→tier ДОЛЖНА быть задокументирована.
- **FR-008 (Migration as `.sql`)**: Любая схема-миграция (унификация лог-таблиц/конфига) генерируется как `.sql` на ревью, не исполняется напрямую.
- **FR-009 (Fail-open)**: fix F10 — Если `responseGuard.run` бросает исключение, движок ДОЛЖЕН доставить последний known-good ответ (не 500), залогировать ошибку и эмитить event с `verdict='warn'`, `detail='degraded'`. Существующие валидаторы и DAR уже fail-open (`pipeline.ts:115-121`, `dar-pipeline.ts:145-156`) — guard наследует это поведение.
- **FR-010 (Additive QualityEventPush)**: fix F3 — Новая `QualityEventPush` форма ДОЛЖНА быть аддитивной над существующим wire-типом (`correction-rules/types.ts:32-47`). Поля `idempotencyKey`, `assistantId`, `snapshotVersion` — ОБЯЗАТЕЛЬНО сохраняются. Переименование полей запрещено (добавка новых OK). Версионирование wire-формы — через `kind`/`legacyMode` дискриминатор.

### Non-Functional Requirements

- **NFR-1 (Cost parity)**: Для персоны без custom-LLM-правил cost-профиль после 027 НЕ растёт (happy-path без LLM-стадий). Verify: счётчик LLM-вызовов на happy-path = как до 027.
- **NFR-2 (Latency)**: p95 латенси response-guard не хуже max(текущий validateResponse, darExecute) — объединение не добавляет последовательный оверхед сверх существующего.
- **NFR-3 (Behavior parity)**: Существующие вердикты валидаторов и DAR воспроизводятся 1:1 (regression-набор на 004/017/018/024 проходит без изменений).
- **NFR-4 (Backward compat)**: Существующие `validator_configs` и correction-rule конфиги читаются без ручной правки; дефолт поведения = как до 027.

## 5. Success Criteria

- **SC-001**: chat-service имеет ОДИН guard-вход; нет раздельных `validateResponse` + `darExecute` call-site (grep подтверждает один orchestration-вызов на каждом из 3 путей).
- **SC-002**: Системные валидаторы перечислены как default-правила в конфиге; попытка удалить system-правило отклоняется; enable/disable/mode работают.
- **SC-003**: Один прогон диалога с нарушением валидатора И custom-правила пишет обе записи в единую лог-форму с общим словарём вердиктов и `ts`.
- **SC-004 (cost)**: happy-path персоны без custom-LLM-правил не делает LLM-вызовов в guard (NFR-1).
- **SC-005 (parity)**: regression-наборы 004/017/018/024 зелёные без изменений ожиданий (NFR-3).
