# Phase 1 Data Model — Marketplace Customer-Comms

> twin-engine (`@undrecreaitwins/*`). Extends 015 contracts; backward-compatible.

## MarketplaceContext (NEW — `packages/shared/src/types.ts`)

Опциональный блок на `ChannelMessage` (не ломает 015 DM-каналы):

| Field | Type | Note |
| --- | --- | --- |
| `marketplace` | `'ozon' \| 'wb' \| 'yandex'` | площадка |
| `kind` | `'question' \| 'review' \| 'order_chat'` | под-тип (WB Question по `nmId` vs чат по заказу) |
| `postingId?` | string | Ozon posting / отправление |
| `orderId?` | string | заказ (WB/Ozon) |
| `sku?` | string | товар (`nmId` у WB) |
| `questionId?` / `reviewId?` | string | WB Questions/Reviews |
| `chatId?` | string | id чата площадки (Ozon `chat_id`) |

`ChannelType` (015 union) += `ozon`, `wb` (Phase 1), `yandex` (Phase 2).

## ChannelMessage extension
`{ …015-поля, marketplaceContext?: MarketplaceContext }`. Адаптер стампит контекст из события
площадки → INBOUND несёт его → OUTBOUND возвращает для маршрутизации ответа в правильный
`chatId`/`questionId`. **Persistence (glm-F4 / FR-012)**: LLM-результат метаданных не несёт →
оркестратор персистит `marketplaceContext` из INBOUND в Redis `mpctx:<conversationId>` (TTL) и
достаёт при OUTBOUND publish.

## channel_instances (reuse 015 + per-mp creds)
Reuse `credentialsCiphertext`+`kmsKeyRef` (015 T005). Marketplace creds: Ozon `Client-Id`+`Api-Key`;
WB token; Я.Маркет OAuth — все зашифрованы KMS, per-(tenant,persona). `inboundMode` per-adapter.

## policy-engine (NEW — `core/services/policy-engine/`, hybrid — glm-F2)
| Entity | Shape |
| --- | --- |
| `PolicyProfile` | `{ id, marketplace, forbiddenPatterns[] (regex), rules: {offPlatformRedirect, contactExchange, externalLinks}, judgeModel, judgeThreshold }` |
| `PolicyResult` | `{ allowed, violations[], confidence, redactedText? }` |
| `PolicyBlockEvent` (FR-011) | `{ timestamp, tenantId, channelType, marketplace, conversationId, messageId, violations[], action: 'blocked'\|'redacted'\|'regenerated' }` — retention 90д; originalText encrypted/redacted |
**Гибрид**: regex prefilter → `confidence < judgeThreshold` → LLM-judge (`judgeModel`). Вызывается из
валидаторов 004 (outbound, post-generation FR-004b) И marketplace-канала. **Fail-closed** через
`MarketplaceRegistry.assertPolicyProfile()` на boot — нет профиля → канал не стартует.
Violation → block+regenerate (макс 2 → silent block + `PolicyBlockEvent`), redact только явных contacts (FR-004d).

## Order-context (NEW — per-mp order-API client)
`OrderContext` `{ marketplace, orderId, status, items[], buyerName? }` — тянется order-API площадки
(Ozon posting / WB order) → инжект как structured block в **system-prompt** (FR-010a). Pull: `order_chat`
всегда, `question` если `sku` совпал. **Cache-key (gemini-F5)**: `cache:marketplace:order:<tenantId>:<postingId>`,
TTL 5мин активные / 30мин закрытые. Деградация (FR-010b): недоступно → system-нота «детали временно
недоступны» (НЕ галлюцинировать статус), отвечаем по тексту.

## Compliance gating (engine-level, FR-005)
Для `channel_type ∈ {ozon,wb,yandex}`: reengagement-scan (009) ПРОПУСКАЕТ conversation;
funnel (003) НЕ активирует redirect-стадии. Флаг `isMarketplace(channelType)` — единый предикат.

## Validation rules
- Outbound marketplace → `policy-engine.check()` ОБЯЗАТЕЛЬНО (поверх валидаторов 004); violation → block + audit.
- Webhook inbound (где есть) → подпись (015 `webhook-signature.ts`) + идемпотентность Redis `seen:<mp>:<id>` SET NX.
- Poll inbound → backoff под рейт-лимит (WB 1 req/s); идемпотентность по `questionId`/`message_id`.
- Креды seller-API: KMS at-rest, не plaintext, не в логах (015 FR-004).
- `health()`: `degraded` при 429/рейт-лимит-окне.
