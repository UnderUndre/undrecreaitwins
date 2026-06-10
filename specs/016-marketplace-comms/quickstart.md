# Quickstart — Marketplace Customer-Comms (016)

## S1 — Ответ на вопрос по товару (US1, MVP)
1. Подключить Ozon-канал tenant'у (seller `Client-Id`+`Api-Key`, зашифрованы KMS).
2. Покупатель задаёт вопрос на карточке → адаптер (webhook|poll) нормализует с `sku`/`questionId` → INBOUND.
3. Движок: RAG по товару (005) + персона → валидаторы 004 + **policy-engine** → OUTBOUND → REST-ответ.
4. **Проверка**: ответ привязан к `questionId`; прошёл гейт+policy; **нет** контактов/увода с площадки; tenant-scoped.

## S2 — Чат покупателя по заказу + order-context (US2)
1. Покупатель пишет в чат по заказу (Ozon posting / WB buyer-chat).
2. Движок тянет order-context (статус/состав) через order-API площадки → RAG (FR-010).
3. Ответ в правильный `chatId`; рейт-лимит площадки соблюдён (WB 1 req/s, backoff).
4. **Проверка**: order-context в ответе; order-API недоступен → деградация (отвечаем по тексту, не падаем).

## S3 — Compliance-guard (US3, NON-NEGOTIABLE)
1. Твин-сейлз с активным funnel/reengagement подключён к marketplace-каналу.
2. **Проверка**: funnel-redirect и reengagement-дожимы НЕ запускаются (engine OFF по `channel_type`);
   попытка модели увести в Telegram/телефон → policy-engine блок + audit-лог;
   канал без policy-профиля площадки → НЕ стартует (fail-closed).

## S4 — Tenant-isolation
Два tenant'а, по Ozon-каналу каждый → нулевое пересечение кред/сообщений/order-context.
