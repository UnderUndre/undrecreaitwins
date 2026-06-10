# Feature Specification: Multi-Channel Gateway (Adapter Port)

**Feature Branch**: `015-multi-channel-gateway`
**Created**: 2026-06-08
**Status**: CLARIFIED (session 2026-06-08)
**Input**: Расширить охват каналов твина с 2 (Telegram, WhatsApp) до ~15,
переиспользуя Hermes' `gateway/platforms/*.py` как референс протоколов.
Адаптеры живут в движке; валидаторный гейт (004) не трогаем.

> **Split note (2026-06-08, CL-1)**: этот спек был зонтиком над тремя треками
> (gateway + builder-unifier + MCP). По решению CL-1 Track A (Gateway) остаётся
> здесь как `015-multi-channel-gateway`; Builder-Unifier + Agent-MCP-Server
> живут в **репозитории `ai-twins`** как `015-agent-builder-unifier-and-mcp-server`
> (НЕ в `undrecreaitwins/016`). В `undrecreaitwins` номер **016 = marketplace-comms** (CL-A10).

## Overview

Сегодня движок говорит наружу через 2 канала (`channel-telegram`,
`channel-whatsapp`), оба реализуют `ChannelAdapter` и развязаны Redis-стримами
(INBOUND/OUTBOUND). Hermes-Agent имеет 16 готовых адаптеров, но его gateway
**per-instance** (один токен-сет, один `~/.hermes`) и **шлёт напрямую** — это
ломает мультитенант и DD-HX-001. Поэтому: НЕ принимаем gateway Гермеса как
рантайм; портируем его адаптеры в движок как новые `channel-*` пакеты.

## Clarifications

### Session 2026-06-08

- **CL-A1 (secret-store, FR-004)** → **частично**: переиспользовать **KMS-примитив**
  (`crypto.ts` — `KmsProvider`/`LocalKmsProvider`/`VaultKmsProvider`, `encryptApiKey/
  decryptApiKey`), НО он сейчас обслуживает **только** LLM-provider-ключи. **Креды
  каналов лежат plaintext** в `channel_instances.config` (jsonb) — колонок под
  ciphertext нет. → FR-004 уточнён (см. Session 2026-06-09). Это не «reuse готового»,
  а «reuse шифр-примитива + достроить колонку».
- **CL-A2 (Phase 3)** → **режем из 015**: Signal (signal-cli daemon), iMessage
  (Mac+BlueBubbles), WeChat (iLink, ToS-риск) выносятся в отдельный gated-спек.
  015 = Phase 1 + Phase 2.
- **CL-A3 (Discord/Slack inbound)** → **Discord = socket (Gateway WS)**; **Slack = webhook**
  (Events API + HMAC) — **уточнено CL-A13 (glm-F18, 2026-06-09)**. Discord Gateway WS — исходящее
  соединение, без публичной URL. Slack — один общий webhook-эндпоинт, роутинг по `team_id` (не
  per-tenant URL). Webhook-класс: Slack + WeCom + Feishu + MS Graph (US3), общий `webhook-signature.ts`.
- **CL-A4 (ChannelMessage расширение)** → **внутри 015** (FR-001), фундамент-фаза
  перед адаптерами; отдельная предтеча — оверхед.
- **CL-A5 (gateway approach, по аудиту twin-engine 2026-06-09)** → **Option A —
  свои TS-адаптеры в twin-engine**. Подтверждено по коду: контракт `ChannelAdapter`
  (`channel-adapter.interface.ts`), `channel-orchestrator.ts` (INBOUND/OUTBOUND +
  дедуп + retry) и валидаторы 004 (внутри `chat-service`) **уже существуют** в
  `undrecreaitwins`. ⚠️ Но «004 = **единственный** путь в OUTBOUND» оказалось
  **ложным** — см. Session 2026-06-09 (две дыры). Добавить канал = реализовать
  5 методов адаптера + стампить `tenant_id`/`persona_slug` + publish (как
  `channel-telegram`). Hermes (Python) = **референс протокола** (DL-2), не рантайм.
  - **Option B** (VPS/Hermes per client) — **отвергнут**: обходит оркестратор-мозг
    (валидаторы 004, дедуп, retry, мультитенант), убивает SaaS-хребет.
  - **Option C** (Python Hermes-сайдкар на Redis-шов) — ниша: только для одного
    адски-сложного протокола (напр. WeChat iLink), где переписать дороже обёртки;
    требует tenant-aware Hermes (стампить tenant_id), не ванильный.

### Session 2026-06-09 — twin-engine audit (external AI)

- **CL-A6 (gate ≠ sole — REENGAGEMENT BYPASS)** → премиса DL-1/FR-003 «валидаторы 004 —
  единственный outbound-гейт» **сегодня ЛОЖНА** на одном пути:
  - **Reengagement bypass** (`reengagement/delivery.ts:49`) публикует в OUTBOUND
    контент, сгенерённый `generator.ts:52` через сырой `llm.complete()` — **минует
    `chatService.complete()` → минует `validateResponse()`**. Прод-контент уходит на
    платформу **невалидированным**. 🔴 Security/safety-баг (существующий, не от 015).
    **→ в работе:** отдельный bug-fix-чип в twin-engine (route через `validateResponse()`).
  - **OK-пути** (валидируются): orchestrator success (`:53`) и error (`:106`), retry
    (`provider-retry.worker.ts:332` → переrun `complete()` с валидаторами). Adapter
    `.send()` зовётся **только** из OUTBOUND-консьюмера (telegram:74, wa:140, mtproto:84) — чисто.
  - **Последствие для 015**: добавляя 13 каналов, множим радиус этой дыры. 015 не чинит
    чужой баг, но **фиксирует** его как gate-0 prerequisite. См. FR-003 + Dependencies.
- **CL-A7 (streaming bypass — N/A для твинов)** → стрим-дыра (`chat-service.ts:537`,
  `recordBypass` только лог) **нерелевантна каналам**: твин **клонирует человека**, а
  человек не отвечает стримингом — ответ твина в канал = **цельное сообщение**, не токены.
  Streaming не является delivery-режимом твина → путь не достижим из channel-OUTBOUND.
  **Guard**: channel-OUTBOUND MUST никогда не использовать streaming-путь (если когда-то
  появится стрим в канал — он обязан пройти валидаторы). Не блокер 015. (Совпадает с
  010 C3: sandbox non-streaming; 002-streaming отложен.)
- **CL-A1 уточнён (secret-store)** → KMS-примитив (`crypto.ts`) есть, но только под
  LLM-ключи; **креды каналов — plaintext в `channel_instances.config` jsonb**. FR-004
  требует новую ciphertext-колонку (паттерн `llm_provider_config.apiKeyCiphertext`) +
  reuse `KmsProvider`. 🟠 Существующий security-gap. **→ в работе:** отдельный
  bug-fix-чип в twin-engine (шифр-колонка + миграция plaintext→ciphertext).

### Session 2026-06-09 (addendum) — RU/CIS каналы + MCP-вопрос

- **CL-A8 (VK, ВКонтакте)** → **в 015, Phase 1**. Community Bot API (`messages.send`),
  Bots **Long Poll** ИЛИ **Callback API**, community-токен. Паритет с Telegram long-poll —
  чистый фит под `ChannelAdapter`. Inbound-режим (FR-008): **v1 = 'bot' (Long Poll, паритет
  telegram, без публичной URL; решено B1)**; Callback API/webhook отложен. ⚠️ ТОЛЬКО
  community/group messaging; userbot (личный аккаунт) — против ToS, НЕ делаем (паритет с
  MTProto-риском 006). Либа-референс: `node-vk-bot-api` (протокол, не зависимость по умолчанию).
- **CL-A9 (Avito Messenger)** → **в 015, Phase 2**. `https://api.avito.ru`, OAuth Bearer,
  scope `messenger:write`, **Webhook V3** (эндпоинт обязан вернуть `200` за ≤2s, иначе ретраи).
  Webhook-канал (FR-006). Гейт: нужен одобренный Avito business-доступ (client_id/secret)
  **per-tenant**. **⚠️ U1 (analyze)**: схема аутентификации Avito Webhook V3 (HMAC vs
  IP-allowlist vs секрет-в-URL) НЕ верифицирована — подтвердить ДО реализации T032, не
  закладываться вслепую на `webhook-signature.ts`. Рейт-лимит из заголовков `X-RateLimit-*` → `channel-rate-limiter.ts`. DM по
  объявлению — фит под текущую модель `ChannelMessage`.
- **CL-A10 (Marketplace-comms: Ozon / Wildberries / Я.Маркет)** → **НЕ в 015 — решено
  (2026-06-09): отдельный спек `016-marketplace-comms`**. Это НЕ DM-каналы:
  - Сообщение привязано к **заказу/товару** (Ozon `chat_id`↔posting `POST /v1/chat/send/message`,
    `Client-Id`+`Api-Key`; WB `buyer-chat-api.wildberries.ru`↔order; + WB Questions/Reviews по
    карточке `nmId`), не к свободному диалогу → другая форма `ChannelMessage`
    (postingId/orderId/SKU/questionId). Расширять базовый контракт под это = протечка модели.
  - Транспорт — **поллинг REST**, жёсткие рейт-лимиты (WB: 1 req/s, burst 3 → блок 60s).
  - 🔴 **Compliance-мина**: маркетплейсы **запрещают увод покупателя с площадки**. Машинерия
    твина — funnel (003) + reengagement-дожимы (009) — заточена ГНАТЬ конверсию/контакты.
    Включить её на Ozon/WB как есть = **бан продавца**. Marketplace-режим ОБЯЗАН отключать
    reengagement/funnel-redirect и резать запрещённый контент валидатором (новый policy-профиль).
    Это **ограниченный режим**, где половина движка под запретом — отдельный домен, не «ещё канал».
- **CL-A11 (каналы как MCP-сервера?)** → **НЕТ для транспорта; путаница двух слоёв.**
  - **Inbound = push-событие** (клиент пишет сам, рантайм реагирует). MCP — **pull-протокол**
    вызова tools агентом-клиентом; нет примитива «сервер сам инициирует входящий разговор +
    дедуп + tenant-стамп + ordering + ack». Это ровно работа Redis-Streams-оркестратора. MCP
    тут — не та труба.
  - **Outbound-send как MCP-tool** возможно технически, но **опасно**: сырой `send_message`-tool
    у мозга = отправка МИМО `validateResponse()` → это дыра CL-A6 (reengagement-bypass),
    возведённая в фичу. Ломает DD-HX-001 (010). Отвергнуто.
  - **Два слоя не путать**: (1) транспорт канала [байты в/из VK/Telegram] = адаптеры+стримы,
    НЕ MCP; (2) capability мозга [что агент может вызвать] = engine-MCP-server (010 FR-002,
    014 per-assistant-mcp) — уже есть. Сам Hermes держит `gateway/` и `mcp_serve.py`/toolsets
    раздельно — даже он не моделит каналы как MCP. Корроборация.
  - **Законное зерно**: можно унифицировать **реестр/конфиг-UX коннекторов** (один способ
    регать/discover канал и MCP-tool в UI коннекторов (билдер — ai-twins `015`)), НЕ рантайм-транспорт.
- **CL-A12 (другие RU/CIS-кандидаты, НЕ верифицированы — TODO перед добавлением)**:
  **Viber** (Bot REST + webhook, жив в CIS — вероятный Phase 1/2), **Одноклассники** (group
  bot API, ниша), **Jivo / веб-виджет чата** (через generic Webhooks, FR-006). Не вписаны в
  Phasing до проверки API (confidence <0.85).

## Decisions locked (требуют подтверждения в /clarify)

- **DL-1 Топология**: адаптеры в движке, контракт `ChannelAdapter` + Redis
  Streams. Валидаторы 004 = единственный outbound-гейт. (наследует DD-HX-001 из 010)
- **DL-2 Hermes-код**: референс-спека, НЕ импорт. TS-rewrite per platform.
  **(подтверждено CL-A5 по аудиту кода.)** Целевая кодовая база — **twin-engine
  (`undrecreaitwins`, TypeScript)**, пакеты `packages/channel-*`; контракт
  `ChannelAdapter` и оркестратор уже есть. FR-001 (расширение `ChannelMessage`) =
  правка `channel-adapter.interface.ts` + `packages/shared/src/types.ts` там же.
- **DL-3 Мультитенант**: инстанс на (tenant, persona, channelId, creds) — как сейчас.
- **DL-4 Out of scope (CL-A2)**: Signal (signal-cli daemon), iMessage
  (Mac+BlueBubbles), WeChat (unofficial iLink — ToS-риск) — **вынесены в отдельный
  gated-спек**, не в 015. 015 покрывает Phase 1 + Phase 2.
- **DL-5 Inbound-режим (CL-A3/CL-A13)**: **Discord = socket** (Gateway WS, исходящее соединение,
  без публичной URL). **Slack = webhook** (Events API + HMAC, один эндпоинт по `team_id` — glm-F18).
  Webhook-класс: Slack/WeCom/Feishu/MS Graph.

## User Scenarios

### US1 — Новый канал отвечает через гейт (P1) 🎯 MVP

Tenant подключает Discord-бота → входящее нормализуется в `ChannelMessage` →
INBOUND → движок (роутинг 010 + валидаторы 004) → OUTBOUND → adapter шлёт.
**Acceptance**: ответ проходит тот же валидаторный путь, что Telegram; токен
скоупится на (tenant, persona); параллельные тенанты не пересекаются.

### US2 — Медиа во входящем/исходящем (P2)

Канал с картинками/голосом (Discord, Slack) → вложения сохраняются и шлются.
**Acceptance**: контракт `ChannelMessage` расширен (attachments), не ломая текст-only.

### US3 — Webhook-каналы за криптой подписи (P2)

WeCom/Feishu/MS Graph → верификация подписи входящего вебхука.
**Acceptance**: невалидная подпись отбрасывается + логируется; порт крипты с Python-референса.

## Functional Requirements

- **FR-001** Расширить `ChannelType` + `ChannelMessage` в `shared`: attachments,
  typing-сигнал, reply-anchor. Обратная совместимость с text-only (telegram/wa).
- **FR-002** Каждый новый канал = пакет `channel-<platform>`, реализует
  `ChannelAdapter`, публикует INBOUND / консьюмит OUTBOUND (фильтр по channelId).
- **FR-003** Валидаторы 004 — единственный outbound-гейт. Адаптер НЕ принимает решений
  о контенте. (constitution / DD-HX-001) **⚠️ Prerequisite (CL-A6)**: сегодня это НЕ так —
  **reengagement** (`delivery.ts:49`) пишет в OUTBOUND мимо `validateResponse()`. До
  масштабирования на 13 каналов закрыть (bug-fix-чип в работе): reengagement-контент ОБЯЗАН
  пройти валидаторы перед OUTBOUND. **Fallback (glm-F2)**: если чип не приземлится за N дней
  (дефолт 14) — stopgap-interceptor в `channel-orchestrator.ts` пере-роутит reengagement через
  `validateResponse()`; 015 не блокируется бесконечно на внешней зависимости. *(Streaming-путь — N/A для твинов, CL-A7; твин не
  стримит. Guard: channel-OUTBOUND не использует streaming.)*
- **FR-004** Креды канала per-(tenant, persona) — **зашифрованы at-rest** через
  `KmsProvider` (`crypto.ts`, reuse примитива), НЕ plaintext, НЕ глобал-env. **CL-A1
  уточнён**: добавить ciphertext-колонку в `channel_instances` (паттерн
  `llm_provider_config.apiKeyCiphertext`) — сейчас креды лежат **plaintext** в
  `config` jsonb (existing gap, мигрировать). **Ротация (glm-F10/gemini-F6)**: flow
  `rotateChannelCredentials` — re-encrypt новым KMS-ключом + reconnect адаптера без даунтайма;
  `kmsKeyRef`-колонка трекает ссылку на ключ (как 011 `keyRef`).
- **FR-005** Per-channel health() + статус в API (наследует ChannelHealth). Агрегирующий
  `GET /api/channels/health` → `{ channels: Record<channelId, ChannelHealth>, overall:
  'healthy'|'degraded'|'down' }`, tenant-scoped; health собирается поллингом (~30s) + кэш в Redis (glm-F7).
- **FR-006** Webhook-каналы (WeCom/Feishu/MS Graph): верификация подписи до публикации
  в INBOUND через общий `webhook-signature.ts` (HMAC-SHA256 + constant-time, порт из Hermes
  один раз — glm-F3), НЕ крипта per-adapter. Идемпотентность редоставки — Redis
  `seen:<channel>:<message_id>` SET NX + TTL до публикации (реплей вебхука не задваивает —
  gemini-F4). Discord = socket-режим (CL-A3); Slack = webhook-режим (CL-A13/glm-F18).
- **FR-007** Грейсфул degrade: упавший адаптер → status 'error', не роняет движок.
- **FR-008** Inbound-транспорт per-channel (CL-A3/CL-A13): **socket** (Discord — исходящее
  WS-соединение, без публичной URL) vs **webhook** (Slack/WeCom/Feishu — signature-verified,
  общий эндпоинт, роутинг по идентификатору воркспейса/площадки). Адаптер объявляет свой режим;
  socket-каналы не требуют публичного эндпоинта, webhook-каналы делят один ingress.

## Non-Functional

- **Isolation**: креды и сессии скоупятся per-tenant. Zero cross-tenant.
- **Cost/Ops**: каждый канал — отдельный консьюмер-процесс; масштабируется как telegram.
- **Security**: webhook-подписи; **креды каналов зашифрованы at-rest (KmsProvider), НЕ
  plaintext** (CL-A1 — сейчас plaintext в `channel_instances.config`, gap); rate-limit на
  входящем через общий `channel-rate-limiter.ts` (per-platform: msgs/sec, длина, media-size;
  адаптеры зовут `rateLimiter.check()` перед send — glm-F8, не дублируют per-adapter; идеи из
  `signal_rate_limit.py`/`_http_client_limits.py`).
- **Gate integrity (CL-A6)**: каждый путь в OUTBOUND проходит валидаторы 004; reengagement
  сейчас — мимо (bug-fix в работе), закрыть до масштабирования. Streaming — N/A (CL-A7, твин не стримит).

## Edge Cases

- Платформенный лимит длины (UTF-16 у Telegram, 24h-окно WhatsApp, 60s-токен LINE) → порт логики из base.py.
- Webhook replay/подделка → подпись + идемпотентность по message_id.
- Канал без typing/media → graceful no-op, не падать.
- Ребаланс OUTBOUND-консьюмеров при рестарте → не терять/не дублить (Redis Streams ack).
- Креш адаптера после consume, до `send` → сообщение в `XPENDING` до idle-timeout (дефолт 5 мин)
  → перевыдача другому консьюмеру; мониторинг pending > порога (glm-F5). Отложенная доставка, не потеря.

## Phasing (по сложности интеграции — из анализа platforms/*.py)

- **Phase 1 (bot/socket/token, близки к Telegram)**: Discord (Gateway WS), Slack (Events API webhook), Mattermost, DingTalk, Feishu (webhook), WeCom (webhook), **VK (Long Poll / Callback API — CL-A8)**.
- **Phase 2 (medium)**: Matrix (matrix-js-sdk), Email (IMAP/SMTP), SMS (Twilio), Webhooks (generic), Home Assistant, **Avito (Messenger webhook V3 — CL-A9)**.
- ~~Phase 3~~ — **вынесена из 015** (CL-A2): Signal/iMessage/WeChat → отдельный gated-спек.
- **Marketplace-comms** (Ozon / Wildberries / Я.Маркет) — **НЕ в 015** (CL-A10): отдельный спек
  `016-marketplace-comms` (PENDING ОК юзера) — другая модель сообщения (order/SKU-scoped) +
  compliance-режим (reengagement/funnel OFF, иначе бан продавца).

## Dependencies / Resolved Questions

- **CL-A1** ⚠️ Secret-store — KMS-примитив есть (только LLM-ключи); креды каналов **plaintext** → FR-004 достраивает ciphertext-колонку (verified 2026-06-09).
- **CL-A4** ✅ `ChannelMessage` расширение — внутри 015 (FR-001).
- **CL-A2** ✅ Phase 3 — режем из 015 (отдельный gated-спек).
- **CL-A3** ✅ Discord — socket (Gateway WS); Slack — webhook (Events API + HMAC, CL-A13/glm-F18).
- **CL-A5** ✅ Gateway approach — Option A (свои TS-адаптеры).
- **CL-A6 🔴 PREREQUISITE (gate-0)**: reengagement (`delivery.ts:49`) пишет в OUTBOUND мимо
  валидаторов. Закрыть до масштабирования каналов. **Bug-fix-чип в twin-engine — в работе.**
- **CL-A7** ✅ Streaming bypass — N/A для твинов (человек не стримит); guard: channel-OUTBOUND без стрима.
- **CL-A1 fix** 🟠 plaintext креды каналов → ciphertext-колонка + KmsProvider. **Bug-fix-чип — в работе.**
- **CL-A8** ✅ VK — в 015 Phase 1 (Community Bot API, long-poll/callback).
- **CL-A9** ✅ Avito — в 015 Phase 2 (Messenger webhook V3, per-tenant business-доступ).
- **CL-A10** ✅ Marketplace-comms (Ozon/WB/Я.Маркет) — **решено (2026-06-09): отдельный спек `016-marketplace-comms`**. Вне 015. Другая модель (order/SKU-scoped) + compliance-режим (funnel/reengagement OFF).
- **CL-A11** ✅ Каналы≠MCP-транспорт — отвергнуто (push-event vs pull-tool; send-as-tool = gate-bypass). Унификация — только на уровне registry/UX билдера (ai-twins `015`).
- **CL-A12** ⏳ Viber / OK / Jivo — кандидаты, API не верифицирован, не в Phasing до проверки.
- **CL-A13** ✅ **Slack = webhook, не socket (glm-F18, решено 2026-06-09)**: код уже webhook+HMAC (рабочий), переписывать на Socket Mode смысла нет. Один общий эндпоинт + роутинг по `team_id` (НЕ per-tenant URL), переиспользует `webhook-signature.ts` + существующий ingress (Feishu/WeCom). Discord остаётся socket (Gateway WS — нет HTTP-варианта). Обновлены CL-A3/DL-5/FR-008.
- **Open (cross-spec)**: detail-view ассистента в **builder-spec (ai-twins `015-agent-builder-unifier-and-mcp-server`)**
  управляет channels этого трека — контракт канал↔`assistantId` согласовать с его канон-API (CL-2 / FR-B03).
  Channel FK — локальный `Assistant.id` (см. builder data-model). Решается при планировании 015.
