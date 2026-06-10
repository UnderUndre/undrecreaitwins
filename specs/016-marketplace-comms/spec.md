# Feature Specification: Marketplace Customer-Comms

**Feature Branch**: `016-marketplace-comms`
**Created**: 2026-06-09
**Status**: DRAFT — specify+clarify (открытые вопросы в §Clarifications needed)
**Input**: Дать твину отвечать покупателям на **маркетплейсах** (Ozon, Wildberries,
Я.Маркет): вопросы по товару, отзывы, чат покупателя по заказу. Выделено из 015
(CL-A10) как **отдельный домен** — НЕ DM-канал.

> **Граница с 015**: `015-multi-channel-gateway` = свободные DM-каналы (Telegram/VK/Discord/
> Avito/…). `016` = **marketplace-comms**: сообщение привязано к заказу/товару, поллинг-транспорт
> с жёсткими лимитами, и **compliance-режим** (увод с площадки запрещён). Переиспользует
> механику 015 (`ChannelAdapter`, Redis-стримы, валидаторы 004), но **расширяет** модель
> сообщения и **ограничивает** машинерию движка.

## Overview

Маркетплейсы дают продавцу API для общения с покупателем, но это **не личка**:
- **Ozon Seller API**: `POST /v1/chat/start`, `POST /v1/chat/send/message`, auth `Client-Id`+`Api-Key`;
  чат привязан к **posting** (отправлению/заказу).
- **Wildberries**: `buyer-chat-api.wildberries.ru` (чат с покупателем по заказу) + Questions/Reviews
  («Вопросы и отзывы» по карточке `nmId`); лимит **1 req/s** (burst 3 → блок 60s).
- **Я.Маркет**: chat API продавца. ⚠️ **НЕ верифицирован** в этой сессии — см. Clarifications.

Три отличия от DM (почему отдельный спек, а не ещё каналы в 015):
1. **Модель сообщения** — order/posting/SKU/questionId-scoped, не свободный диалог.
2. **Транспорт** — поллинг REST (нет постоянного WS/long-poll), жёсткие per-seller рейт-лимиты.
3. 🔴 **Compliance** — площадки **банят за увод покупателя с маркетплейса**. Funnel (003) +
   reengagement-дожимы (009) заточены гнать контакт/конверсию → включить как есть = бан продавца.

## Clarifications

### Session 2026-06-09 (/speckit.clarify)

- **CL-016-1 (продукт)** → **Полный твин, policy-gated**. На маркетплейсах — полноценный твин
  (персона, RAG по товару 005, многошаг), НО funnel-redirect (003) + reengagement (009)
  принудительно OFF, и marketplace-policy режет увод с площадки. Максимум пользы в рамках ToS.
  Подтверждает DL-4. (Урезанный «только Q&A» и заморозка — отвергнуты.)
- **CL-016-2 (транспорт)** → **Webhook-where-available, poll-fallback**. Если у площадки есть
  push-уведомления о новых сообщениях/вопросах — webhook (меньше нагрузка, ниже латентность);
  иначе — поллер с backoff. Адаптер объявляет фактический режим. ⚠️ Наличие webhook у Ozon/WB
  требует верификации API (см. Open). Уточняет DL-3/FR-002.
- **CL-016-3 (policy)** → **Отдельный shared policy-модуль**. Marketplace-policy (увод с площадки,
  запрещённые формулировки) выносится в переиспользуемый `policy-engine`-модуль, который зовут И
  валидаторы 004, И marketplace-канал 016. НЕ дубль в 016, НЕ только правка 004. Уточняет FR-004.
- **CL-016-4 (order-контекст)** → **Да, через order-API площадки**. US2 тянет статус/состав заказа
  (Ozon posting / WB order API) в RAG-контекст ответа. +интеграция с order-API каждой площадки.
  Уточняет US2/добавляет FR-010.

## Decisions locked

- **DL-1 Reuse 015 spine**: `ChannelAdapter`-контракт, Redis-стримы (INBOUND/OUTBOUND),
  валидаторы 004, per-(tenant,persona) изоляция, KMS-шифр кред (015 FR-004) — переиспользуются.
- **DL-2 Новый поддомен модели**: расширить полезную нагрузку маркетплейс-метаданными
  (`postingId`/`orderId`/`sku`(nmId)/`questionId`/`reviewId`) — НЕ ломая базовый `ChannelMessage`
  (новые поля опциональны / отдельный `MarketplaceContext`).
- **DL-3 Транспорт = webhook-where-available, poll-fallback (CL-016-2)**: если площадка даёт
  push (webhook) о новых сообщениях/вопросах — используем его; иначе per-channel поллер с backoff
  под рейт-лимит. Адаптер объявляет фактический режим (`'webhook'|'poll'`). Outbound → REST send.
- **DL-4 Compliance-режим (NON-NEGOTIABLE)**: для marketplace-каналов движок **принудительно
  ВЫКЛЮЧАЕТ** funnel-redirect (003) и reengagement-дожимы (009); валидатор 004 получает
  **marketplace-policy-профиль**, режущий обмен контактами / увод с площадки / запрещённые
  площадкой формулировки. Без этого профиля marketplace-канал НЕ поднимается (fail-closed).
- **DL-5 Без userbot/скрейпа**: только официальные seller-API. Никаких неофициальных обёрток
  (паритет с ToS-риском WeChat/MTProto).
- **DL-6 Cross-spec fallback (glm-F1, NON-NEGOTIABLE для разблокировки)**: 016 требует правок в 3
  чужих доменах (policy→004, funnel-OFF→003, reeng-skip→009). Чтобы НЕ зависнуть, если владелец
  спеки откажет — **каждая зависимость имеет план-Б**:
  - **policy ↔ 004**: если 004 не интегрирует `policy-engine` → marketplace-адаптер зовёт
    `policy-engine.check()` **сам, pre-OUTBOUND** (suboptimal — теряется двойная проверка из гейта 004,
    но работает). Stopgap, не v1-цель.
  - **gating ↔ 003/009**: если 003/009 не примут OFF-точки → `isMarketplace()`-гейт в
    `channel-orchestrator.ts` (INBOUND-консьюмер): marketplace-канал НЕ роутится в funnel/reengagement path.
  - **Окно**: фиксируем N-дневное ожидание координации (дефолт 14, как 015 glm-F2); по истечении — fallback.

### Session 2026-06-09 (review remediation — gemini + glm)

Внешние ревью (gemini MEDIUM, glm HIGH) разобраны. Резолюции зашиты в FR/DL/contracts/data-model:
- **glm-F1 CRITICAL** (cross-spec deadlock) → **DL-6** (fallback-план + окно).
- **gemini-F1 CRITICAL** (fail-closed enforcement) → **FR-004c** (`MarketplaceRegistry` boot-ассерт).
- **glm-F2 HIGH** (regex insufficient) → **FR-004a** (hybrid regex+LLM-judge). *(ценовой трейд-офф принят: бан > judge-вызов.)*
- **glm-F3 HIGH** (chat discovery) → **FR-002a** (watched-entities + round-robin).
- **glm-F4 HIGH** (routing gap) → **FR-012** (persist marketplaceContext INBOUND→OUTBOUND).
- **gemini-F2 HIGH** (RAG leakage) → **FR-004b** (policy post-generation, любой источник).
- **gemini-F3 HIGH** (poller lag) → **FR-009** (poller-lag порог в health).
- **glm-F5 / glm-F6+gem-F4 / gem-F5 / glm-F7 / glm-F8+gem-F6 (MEDIUM)** → FR-004d / FR-010a-b / FR-010c / FR-006 / FR-011.
- **glm-F9/F10/F11/F12 (LOW)** → уже закрыты прошлым ходом (yandex→M015, M014-тег, M019-граф, constitution-overreach).

## User Scenarios

### US1 — Ответ на вопрос по товару (P1) 🎯 MVP
Покупатель задал вопрос на карточке (WB Questions / Ozon chat) → поллер ловит → нормализует с
`sku`/`questionId` → INBOUND → движок (RAG по товару 005 + персона) → валидаторы 004
(+ marketplace-policy) → OUTBOUND → REST-ответ на площадку.
**Acceptance**: ответ проходит гейт 004 + policy; привязан к правильному `questionId`/чату;
tenant-scoped; **никакого увода с площадки** в тексте (policy режет).

### US2 — Чат покупателя по заказу (P1)
Покупатель пишет в чат по заказу (Ozon posting / WB buyer-chat) → твин отвечает в контексте
**заказа** (статус/состав, если доступно через order API).
**Acceptance**: ответ в правильный `chat_id`↔posting; рейт-лимит площадки соблюдён (backoff, без блока).

### US3 — Compliance-guard (P1, NON-NEGOTIABLE)
Твин-сейлз с активным funnel/reengagement подключается к marketplace-каналу.
**Acceptance**: на marketplace-канале funnel-redirect и reengagement-дожимы **не запускаются**
(движок их глушит по типу канала); попытка модели увести в Telegram/телефон → валидатор режет +
логирует; без policy-профиля канал не стартует.

### Edge Cases
- Рейт-лимит площадки (WB 1 req/s) → backoff-очередь на send; не блокируемся, не теряем.
- Поллинг пропустил событие / дубль при ретрае → идемпотентность по `questionId`/`message_id` (Redis SET NX).
- Вопрос без чата (WB Question) vs чат по заказу (Ozon posting) → разные под-типы, единый INBOUND-контракт.
- Площадка вернула 429/5xx на send → ретрай с backoff; превышение окна → `health:'degraded'`.
- Модель сгенерила увод с площадки → policy-валидатор блок (US3); ничего не уходит.
- Reengagement-воркер (009) пытается дожать marketplace-conversation → подавлен по типу канала (DL-4).

## Functional Requirements

- **FR-001** Marketplace-метаданные в INBOUND/OUTBOUND: `marketplace` (ozon/wb/yandex),
  `postingId?`/`orderId?`/`sku?`(nmId)/`questionId?`/`reviewId?`/`chatId?`. Опционально → не ломает 015.
- **FR-002** Per-marketplace adapter (`@undrecreaitwins/channel-<mp>`), реализует `ChannelAdapter`;
  `inboundMode:'webhook'` (если площадка даёт push) **или** `'poll'` (поллер с backoff под
  рейт-лимит) — CL-016-2. Webhook-режим верифицирует подпись/идемпотентность (015 FR-006); оба
  нормализуют → INBOUND.
- **FR-002a (chat discovery — glm-F3)**: poll-режим ОБЯЗАН иметь стратегию обнаружения **новых**
  чатов/вопросов. Адаптер держит список **watched-entities** (WB: `nmId` карточек с активностью;
  Ozon: открытые `chat_id`) и опрашивает их **round-robin под рейт-лимит** с приоритизацией
  (активные/недавние чаты — чаще; «холодные» SKU — реже/по требованию). Без стратегии: WB 1 req/s
  × N SKU = неприемлемый цикл (1000 SKU ≈ 16 мин). Конкретные эндпоинты discovery — research-spike M008.
- **FR-003** Outbound → официальный seller REST (Ozon `/v1/chat/send/message`; WB buyer-chat / answer
  question; Я.Маркет — TBD). Ack после успешной отправки.
- **FR-004** **Compliance-policy = отдельный shared `policy-engine`-модуль (CL-016-3)**, который
  зовут И валидаторы 004, И marketplace-канал. Режет обмен контактами, увод с площадки,
  запрещённые площадкой формулировки (per-marketplace правила). НЕ дубль логики в 016, НЕ только правка 004.
  - **FR-004a (hybrid policy — glm-F2)**: regex-only НЕДОСТАТОЧЕН (LLM обходит семантически:
    «зелёный мессенджер», гомоглифы `Τelegram`, «+seven-999»). Гибрид (паритет с `false-promise`
    валидатором 004): **regex prefilter** на явные совпадения → **LLM-judge** на low-confidence.
    `PolicyEngine.check()` → `{ allowed, violations[], confidence }`; `confidence < порога` → judge-call
    (~5-15% ответов, не 100%). `PolicyProfile.judgeModel` конфигурируется.
  - **FR-004b (применение — gemini-F2)**: policy ОБЯЗАН применяться **после генерации**, к ЛЮБОМУ
    outbound, независимо от источника (RAG 005 / persona-доки могут нести off-platform-инструкции).
  - **FR-004c (fail-closed enforcement — gemini-F1)**: `MarketplaceRegistry` ассертит наличие
    валидного `PolicyProfile` для типа канала **на boot, ДО init адаптера**. Нет профиля → адаптер не поднимается.
  - **FR-004d (block vs redact — glm-F5)**: при violation — **block + regenerate** (system-hint
    «previous response violated marketplace policy, retry without off-platform content», макс 2 попытки →
    silent block + audit). `redact` — только для явных contacts/phone (regex-clean), НЕ для семантических.
- **FR-005** Движок ВЫКЛЮЧАЕТ funnel-redirect (003) + reengagement (009) для `channel_type ∈ marketplace`.
  Машинерия дожимов не трогает marketplace-conversations.
- **FR-006** Рейт-лимит per-marketplace через `channel-rate-limiter.ts` (015 T028): WB 1 req/s
  (burst 3 → блок 60s), Ozon/Я.Маркет — по докам. Backoff-очередь на send. **⚠️ Per-seller-key
  (glm-F7)**: лимит площадки — **per API-key (продавец)**, НЕ per `channelType`. Если у tenant'а
  2 persona на одном WB-аккаунте → шарят токен → лимитер ОБЯЗАН быть per-`(tenantId, marketplace,
  credsRef)`-группе. `channel-rate-limiter.ts` нужна extension под multi-key.
- **FR-007** Идемпотентность: `seen:<mp>:<questionId|message_id>` Redis SET NX + TTL (поллинг-дубли/ретраи).
- **FR-008** Креды seller-API (Ozon `Client-Id`+`Api-Key`; WB token; Я.Маркет OAuth) — зашифрованы
  через KMS (015 FR-004), per-(tenant,persona), не plaintext, не в логах.
- **FR-009** Per-channel `health()` + агрегат (как 015 FR-005); `degraded` при рейт-лимит/429-окне.
  **Poller-lag порог (gemini-F3)**: `health()` различает **нормальный backoff** и **«адаптер
  застрял/заблокирован»** — если лаг опроса > порога (или WB-блок 60s повторяется) → `degraded`/`error`,
  не молчаливое отставание.
- **FR-010** **Order-контекст (CL-016-4)**: для US2 (чат по заказу) тянуть статус/состав заказа
  через order-API площадки (Ozon posting / WB order) в RAG-контекст ответа. Per-marketplace
  order-API клиент; кэш + рейт-лимит. Деградация: order-API недоступен → отвечаем по тексту (не падаем).
  - **FR-010a (инжект — glm-F6)**: `OrderContext` → structured block в **system-prompt** («Заказ
    #{orderId}, статус {status}, состав {items}. Отвечай в контексте этого заказа»). Pull-условие:
    `kind:'order_chat'` → всегда; `kind:'question'` → если `sku` совпадает. Cache TTL: 5 мин активные / 30 мин закрытые.
  - **FR-010b (degradation-нота — gemini-F4)**: order-API недоступен → инжектить system-ноту
    «детали заказа временно недоступны, сообщи покупателю» — чтоб модель НЕ галлюцинировала статус.
  - **FR-010c (cache-key — gemini-F5)**: формат `cache:marketplace:order:<tenantId>:<postingId>` —
    per-tenant-per-order, без cross-tenant утечки.
- **FR-011 (audit — glm-F8/gemini-F6)**: каждый policy-block логируется структурным `PolicyBlockEvent`
  `{ timestamp, tenantId, channelType, marketplace, conversationId, messageId, violations[],
  action: 'blocked'|'redacted'|'regenerated' }`. Retention 90 дней (бизнес-требование: маркетплейс
  при бане запросит доказательства фильтрации). Оригинальный текст — зашифрован/redacted в логе (Standing Order 4).
- **FR-012 (MarketplaceContext routing — glm-F4)**: INBOUND `marketplaceContext` ОБЯЗАН пробрасываться
  через весь pipeline и возвращаться в OUTBOUND (иначе адаптер не знает, в какой `chatId`/`questionId`
  слать ответ — LLM-результат метаданных не содержит). Механизм: оркестратор персистит контекст из
  INBOUND в conversation-store (или Redis `mpctx:<conversationId>`, TTL) → OUTBOUND-консьюмер достаёт.

## Non-Functional

- **Compliance (CRITICAL)**: ни одного исходящего с уводом покупателя с площадки. Policy-профиль —
  обязательный гейт; нарушение = риск бана продавца. Аудит каждого заблокированного ответа.
- **Rate-limit discipline**: поллинг + send строго под лимитами площадки; backoff, не блок.
- **Isolation**: seller-креды per-tenant, zero cross-tenant (как 015).
- **No off-platform**: контакты/ссылки/мессенджеры в ответах режутся (FR-004).

## Phasing

- **Phase 1**: **Ozon** (chat API чёткий: `/v1/chat/start`, `/v1/chat/send/message`) +
  **Wildberries** (Questions/Reviews + buyer-chat). Доказать compliance-режим (DL-4/FR-004/FR-005).
- **Phase 2**: **Я.Маркет** (после верификации API).

## Dependencies / Clarifications needed

- **Зависит от 015**: `ChannelAdapter`, Redis-стримы, валидаторы 004, KMS-креды, `channel-rate-limiter.ts`
  (T028), `webhook-signature.ts` (если у площадок есть webhook вместо поллинга). 016 НЕ стартует
  раньше, чем 015-foundation (T003–T006) приземлится.
- **Зависит от 004**: нужен **новый policy-профиль** в валидаторах — это правка спеки 004 или
  расширение. Согласовать.
- **Зависит от 003/009**: механизм «выключить funnel/reengagement по типу канала» — точка интеграции
  в reengagement-runtime (009) и funnel-движке (003). Может потребовать их правок.

### Clarifications — статус (после /speckit.clarify 2026-06-09)

- ✅ **#1 Продукт** → CL-016-1: полный твин, policy-gated.
- ✅ **#3 Order-контекст** → CL-016-4: тянем через order-API (FR-010).
- ✅ **#4 Транспорт** → CL-016-2: webhook-where-available, poll-fallback (FR-002).
- ✅ **#5 Policy** → CL-016-3: отдельный shared `policy-engine`-модуль (FR-004).
- ⏳ **#2 Я.Маркет API** — research-TODO (Phase 2): есть ли seller chat API, транспорт/лимиты? Не блокирует Phase 1.
- ⏳ **Research (часть #4)**: верифицировать наличие/схему webhook у Ozon/WB (push vs только поллинг). Решает фактический `inboundMode` per-площадка на этапе plan/implement.
