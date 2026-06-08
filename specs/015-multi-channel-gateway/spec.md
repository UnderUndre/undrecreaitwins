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
> вынесены в [`016-agent-builder-unifier-and-mcp-server`](../016-agent-builder-unifier-and-mcp-server/spec.md).

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
- **CL-A3 (Discord/Slack inbound)** → **bot/socket mode**: Discord Gateway WS +
  Slack Socket Mode (исходящее соединение, без публичной URL per-tenant; паритет
  с Telegram long-poll). Webhook-режим — только для WeCom/Feishu/MS Graph (US3).
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
- **DL-5 Inbound-режим (CL-A3)**: Discord/Slack — **bot/socket mode** (Gateway WS /
  Socket Mode, исходящее соединение, без публичной URL). Webhook — только WeCom/Feishu/MS Graph.

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
  `kmsKeyVersion`-колонка трекает версию ключа.
- **FR-005** Per-channel health() + статус в API (наследует ChannelHealth). Агрегирующий
  `GET /api/channels/health` → `{ channels: Record<channelId, ChannelHealth>, overall:
  'healthy'|'degraded'|'down' }`, tenant-scoped; health собирается поллингом (~30s) + кэш в Redis (glm-F7).
- **FR-006** Webhook-каналы (WeCom/Feishu/MS Graph): верификация подписи до публикации
  в INBOUND через общий `webhook-signature.ts` (HMAC-SHA256 + constant-time, порт из Hermes
  один раз — glm-F3), НЕ крипта per-adapter. Идемпотентность редоставки — Redis
  `seen:<channel>:<message_id>` SET NX + TTL до публикации (реплей вебхука не задваивает —
  gemini-F4). Discord/Slack идут bot/socket-режимом (CL-A3), не webhook.
- **FR-007** Грейсфул degrade: упавший адаптер → status 'error', не роняет движок.
- **FR-008** Inbound-транспорт per-channel (CL-A3): bot/socket (Discord/Slack — исходящее
  WS-соединение, без публичной URL per-tenant) vs webhook (signature-verified). Адаптер
  объявляет свой режим; gateway не требует публичного эндпоинта для socket-каналов.

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

- **Phase 1 (bot/socket/token, близки к Telegram)**: Discord (Gateway WS), Slack (Socket Mode), Mattermost, DingTalk, Feishu (webhook), WeCom (webhook).
- **Phase 2 (medium)**: Matrix (matrix-js-sdk), Email (IMAP/SMTP), SMS (Twilio), Webhooks (generic), Home Assistant.
- ~~Phase 3~~ — **вынесена из 015** (CL-A2): Signal/iMessage/WeChat → отдельный gated-спек.

## Dependencies / Resolved Questions

- **CL-A1** ⚠️ Secret-store — KMS-примитив есть (только LLM-ключи); креды каналов **plaintext** → FR-004 достраивает ciphertext-колонку (verified 2026-06-09).
- **CL-A4** ✅ `ChannelMessage` расширение — внутри 015 (FR-001).
- **CL-A2** ✅ Phase 3 — режем из 015 (отдельный gated-спек).
- **CL-A3** ✅ Discord/Slack — bot/socket mode (FR-008).
- **CL-A5** ✅ Gateway approach — Option A (свои TS-адаптеры).
- **CL-A6 🔴 PREREQUISITE (gate-0)**: reengagement (`delivery.ts:49`) пишет в OUTBOUND мимо
  валидаторов. Закрыть до масштабирования каналов. **Bug-fix-чип в twin-engine — в работе.**
- **CL-A7** ✅ Streaming bypass — N/A для твинов (человек не стримит); guard: channel-OUTBOUND без стрима.
- **CL-A1 fix** 🟠 plaintext креды каналов → ciphertext-колонка + KmsProvider. **Bug-fix-чип — в работе.**
- **Open (cross-spec)**: detail-view ассистента в `016` управляет channels этого трека —
  контракт канал↔`assistantId` согласовать с канон-API 016 (CL-2 / FR-B03). Channel FK —
  локальный `Assistant.id` (см. 016 data-model). Решается при планировании 015.
