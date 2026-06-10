# Phase 0 Research — Marketplace Customer-Comms

> Target = twin-engine (`@undrecreaitwins/*`, TS). Reuses 015 spine; research = deltas.

## R1 — Reuse 015 foundation (no unknown)
**Decision**: reuse `ChannelAdapter`, Redis-стримы (INBOUND/OUTBOUND), валидаторы 004,
KMS-креды (015 FR-004), `channel-rate-limiter.ts` (015 T028), `webhook-signature.ts` (015 T027).
016 = новые `channel-<mp>` пакеты + новые поддомены модели/политики. **Rationale**: 016 НЕ
стартует раньше 015-foundation (T003–T006).

## R2 — Compliance regime = NON-NEGOTIABLE (CL-016-1/DL-4/FR-005)
**Decision**: для `channel_type ∈ marketplace` движок принудительно ВЫКЛЮЧАЕТ funnel-redirect
(003) и reengagement-дожимы (009). Точки интеграции: reengagement-runtime (009) скан игнорирует
marketplace-conversations; funnel-движок (003) не активирует redirect-стадии. **Rationale**:
маркетплейсы банят увод с площадки. **Alt rejected**: «надеяться на промпт» — недетерминированно,
риск бана; gating обязан быть на уровне движка, не персоны.

## R3 — Policy = shared module (CL-016-3/FR-004)
**Decision**: выделить `core/services/policy-engine` — переиспользуемый модуль с per-marketplace
profile (запрещённые формулировки: контакты, увод, ссылки). Зовут И валидаторы 004 (outbound-гейт),
И marketplace-канал. **Fail-closed**: нет профиля площадки → канал не стартует. **Alt rejected**:
дубль в 016 (расхождение с 004); только правка 004 (не переиспользуемо вне валидаторов).

## R4 — Transport: webhook-where-available, poll-fallback (CL-016-2/FR-002)
**Decision**: адаптер объявляет `inboundMode: 'webhook'|'poll'`. Webhook (если площадка даёт push)
→ подпись/идемпотентность (015 FR-006); poll → backoff под рейт-лимит.
**⚠️ OPEN (research-TODO, plan/implement-time)**: верифицировать наличие webhook у:
- **Ozon**: chat API подтверждён (`POST /v1/chat/start`, `/v1/chat/send/message`, `Client-Id`+`Api-Key`);
  наличие push-уведомлений о новых сообщениях — **проверить** (иначе поллинг чата).
- **Wildberries**: `buyer-chat-api.wildberries.ru` + Questions/Reviews (`nmId`); лимит **1 req/s**
  (burst 3 → блок 60s). Webhook — **проверить** (вероятно поллинг).
**Alt rejected**: all-poll (лишняя нагрузка где есть push); all-webhook (не у всех есть).

## R5 — Marketplace message model (DL-2/FR-001)
**Decision**: НЕ ломать `ChannelMessage`; добавить опциональный `marketplaceContext`
(`marketplace`/`postingId`/`orderId`/`sku`(nmId)/`questionId`/`reviewId`/`chatId`). Под-типы:
WB Question (по карточке `nmId`, без чата) vs Ozon/WB чат по заказу (по `chatId`↔posting).
**Alt rejected**: расширять базовый `ChannelMessage` обяз. полями (ломает DM-каналы 015).

## R6 — Order-context (CL-016-4/FR-010)
**Decision**: per-marketplace order-API клиент (Ozon posting / WB order) → статус/состав в RAG для
US2; кэш + рейт-лимит; деградация при недоступности (отвечаем по тексту). **Alt rejected**:
text-only (теряем контекст заказа — продуктово хуже, CL-016-4).

## R7 — Я.Маркет (Phase 2)
**Decision (deferred)**: seller chat API Я.Маркет **НЕ верифицирован**. Research-TODO до Phase 2:
наличие chat API, транспорт, лимиты. Не блокирует Phase 1 (Ozon+WB).

## Summary
| Unknown | Resolution |
| --- | --- |
| Foundation | reuse 015 (R1) |
| Compliance gating | engine-level OFF funnel/reengO (R2) |
| Policy | shared policy-engine module (R3) |
| Transport | webhook-or-poll; Ozon/WB webhook TODO (R4) |
| Message model | optional marketplaceContext (R5) |
| Order-context | per-mp order-API + degrade (R6) |
| Я.Маркет | deferred, unverified (R7) |
