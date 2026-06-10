# SpecKit Review: 016-marketplace-comms

**Reviewer**: glm
**Reviewed at**: 2026-06-09T18:45:00+03:00
**Commit**: 9e30d79147fca33e4a843e450f2f0d322244c1df
**Artifacts reviewed**: spec.md, plan.md, tasks.md, data-model.md, contracts/marketplace-comms.contract.md, research.md, quickstart.md, .specify/memory/constitution.md, reviews/gemini.md, reviews/analyze.md

## Summary

Спек грамотно выделяет marketplace-comms в отдельный домен (CL-A10) и правильно идентифицирует три ключевых отличия от DM-каналов (order-scoped модель, polling transport, compliance-режим). Переиспользование 015-хребта обосновано. Главные слабости: (1) `policy-engine` спроектирован как regex-фильтр (`forbiddenPatterns[]`) — этого недостаточно для compliance-риска уровня бана продавца (LLM генерирует семантические обходы, а не буквальные паттерны); (2) polling-модель не проработана — как адаптер обнаруживает *новые* чаты/вопросы? 1 req/s на WB при 1000 чатов = 16 минут на полный цикл опроса; (3) cross-spec зависимости от 003/004/009 не имеют fallback-плана — если правки воронки/повторного вовлечения отклонены, 016 заблокирован бесконечно; (4) `MarketplaceContext` в OUTBOUND не маршрутизируется оркестратором — отсутствует путь от `chatService.complete()` до адаптера с marketplace-метаданными.

## Findings

| ID | Severity | Area | Finding | Recommendation |
|---|---|---|---|---|
| F1 | **CRITICAL** | Architecture | **Cross-spec dependency deadlock — no fallback** (plan.md P0-M1/P0-M2, tasks.md M004/M006, analyze F2/F3): 016 требует модификации трёх чужих доменов — validators 004 (policy-engine integration), funnel 003 (OFF marketplace), reengagement 009 (skip marketplace-conv). Если хотя бы один владелец спеки откажет — 016 заблокирован без плана-Б. Аналогично 015-F2 (reengagement bypass) — там stopgap спас, здесь нет even stopgap. | Добавить fallback-задачи: (a) если 004 не принимает policy-engine → 016 ставит policy-check **внутри адаптера** (pre-OUTBOUND в адаптере, мимо 004 — suboptimal, но работает); (b) если 003/009 не принимают OFF-точки → `isMarketplace()` gate в `channel-orchestrator.ts` (INBOUND consumer) — если канал маркетплейсный, не роутить в funnel/reengagement path. Фиксировать N-дневное окно ожидания (как 015 glm-F2). |
| F2 | **HIGH** | Security | **Policy-engine regex-only = insufficient compliance** (contracts §2, data-model.md §policy-engine): `PolicyProfile.forbiddenPatterns[]` — regex-паттерны. LLM обходит regex семантически: "напишите нам в тг" (сокращение), "Telegram" с гомоглифами (Τelegram), "пишите в тот зелёный мессенджер", "наш номер +seven-999…", косвенный увод ("поищите нас в интернете по названию"). Каждый паттерн = regex, каждый обход = новый паттерн — бесконечная игра кошки-мышки. Бан продавца = бизнес-критический риск. | Гибридный подход (паритет с `false-promise` валидатором в 004): regex prefilter для очевидных совпадений → LLM-judge для семантических обходов. `PolicyEngine.check()` возвращает `{ allowed, violations[], confidence }`; если confidence < порога → LLM-judge call. Это ~5-15% ответов (как в false-promise), не 100%. Добавить `judgeModel` в `PolicyProfile`. |
| F3 | **HIGH** | Completeness | **Chat discovery / polling model undefined** (spec.md FR-002, research.md R4): адаптер объявляет `inboundMode:'poll'` (fallback), но spec не описывает КАК обнаруживать новые чаты/вопросы. Ozon: нужно ли вызывать chat list API? Какой эндпоинт? Как пагинировать? WB: 1 req/s rate-limit + `nmId`-scoped Questions — как узнать какие `nmId` мониторить? При 1000 SKU = 1000 реквестов = 16 минут на цикл. Нет концепции "chat subscription" или "watched entities". | Добавить research-spike или явный FR: адаптер Marketplace хранит список "наблюдаемых сущностей" (SKU для WB Questions, chat_id для Ozon) и опрашивает round-robin под rate-limit. Или: приоритезация (только активные чаты, не все SKU). В tasks — M008 недостаточно (только webhook vs poll), нужен M008+ для chat discovery strategy. |
| F4 | **HIGH** | Architecture | **MarketplaceContext routing gap in orchestrator** (contracts §5, data-model.md §ChannelMessage): OUTBOUND payload несёт `marketplaceContext` (для маршрутизации ответа в правильный `chatId`/`questionId`), но `chatService.complete()` → OUTBOUND publish не знает о marketplace-метаданных. INBOUND публикуется с `marketplaceContext`, но движок (chat-service) теряет его — OUTBOUND publish происходит из результата LLM, который не содержит `chatId`/`questionId`. Это не routing в оркестраторе, это **data flow gap**: INBOUND `marketplaceContext` должен пробрасываться через весь pipeline и возвращаться в OUTBOUND, но нигде не описано где он хранится (conversation metadata? Redis key? cached in chat-service?). | Определить explicitly: INBOUND `marketplaceContext` сохраняется в conversation metadata (или Redis key `mpctx:<conversationId>`) → при OUTBOUND publish извлекается и добавляется в payload. Добавить в contract §5 или data-model: "orchestrator persists marketplaceContext from INBOUND to conversation-level store; OUTBOUND consumer retrieves it." Без этого адаптер не знает куда отправить ответ. |
| F5 | **MEDIUM** | Security | **Policy behavior ambiguity — block vs redact** (contracts §2, data-model.md §policy-engine): `PolicyResult.redactedText?` предполагает что policy может "зачистить" текст и пропустить. Но если policy редачит "напишите в Telegram 12345" → "напишите в [REDACTED]", ответ выглядит сломанным и вызывает подозрения у покупателя. Лучшая стратегия для marketplace = **block + regenerate** (перегенерировать с compliance-hint в промпте), не redact. | Определить поведение: `PolicyResult` возвращает `{ allowed: false, reason }` → движок перегенерирует с system-prompt "previous response violated marketplace policy, retry without off-platform content" (максимум 2 попытки, потом silent block + audit). Redact — только для явных contacts/phone (regex-clean), не для семантических violations. |
| F6 | **MEDIUM** | Completeness | **Order-context injection into RAG — mechanism undefined** (spec.md FR-010, contracts §3, tasks.md M011): FR-010 говорит "тянуть статус/состав заказа через order-API → RAG-контекст". Но контракт не определяет: (a) как OrderContext инжектится в промпт (system message? user context? metadata?); (b) при каком условии тянется (каждый ответ? только если сообщение от покупателя содержит "заказ"?); (c) TTL кэша (TTL для "в пути" vs "доставлен" — разный). | Добавить в contract: `OrderContext` инжектится как structured block в system prompt: "Заказ #{orderId}, статус: {status}, состав: {items}. Отвечай в контексте этого заказа." Pull condition: для `kind: 'order_chat'` — всегда; для `kind: 'question'` — если `sku` совпадает. Cache TTL: 5 мин для активных чатов, 30 мин для закрытых. |
| F7 | **MEDIUM** | Edge case | **Multi-tenant rate-limit collision on marketplace API** (spec.md FR-006, data-model.md): `channel-rate-limiter.ts` (015) лимитирует per `channelType`. Но WB rate-limit 1 req/s — это **per API key** (per seller), не per channel type. Если у tenant'а 2 persona на WB ( разные магазины ) — они шарят один токен? Или у каждого свой? Если один токен — rate limiter должен быть per-tenant-per-marketplace, не per-channel-type. | Уточнить: rate limiter для marketplace = per `(tenantId, marketplace, credentials)` group, не per `channelType`. `channel-rate-limiter.ts` из 015 нужна extension для multi-key rate limiting. Добавить в FR-006 или M012. |
| F8 | **MEDIUM** | Ops | **No audit trail spec for policy blocks** (spec.md §Non-Functional "audit", gemini F6): gemini справедливо отметил, но занизил до LOW. При бане продавца marketplace запросит доказательства что система фильтровала prohibited content. Audit log = business requirement: кто, когда, какой текст, какое правило, какой результат. Нет структуры события, нет retention policy. | Добавить `PolicyBlockEvent` type в data-model: `{ timestamp, tenantId, channelType, marketplace, conversationId, messageId, violations[], originalText (encrypted?), action: 'blocked'|'redacted'|'regenerated' }`. Retention: 90 дней. Добавить в M005 или M014. |
| F9 | **LOW** | Spec drift | **`yandex` in MarketplaceContext union — premature** (data-model.md, analyze C1): analyze уже отметил — `yandex` в union, хотя API не верифицирован. M003 добавит `ozon`+`wb` и `yandex` одновременно. | Добавлять `yandex` с M015 (Phase 2), как tasks.md C1 уже рекомендует. В M003 — только `ozon`+`wb`. |
| F10 | **LOW** | Completeness | **M014 agent tag mismatch** (tasks.md, analyze F4): M014 тегирован `[SEC]` в описании, но `[E2E]` в dispatch/summary. Agent count = 20, tasks = 19. | Fix: M014 = `[SEC]` (compliance E2E — это security-тест). Пересчитать summary: `[E2E]` = 2 (M010, M013). |
| F11 | **LOW** | Dependencies | **M019 orphan in dependency graph** (tasks.md §Dependency Graph, analyze F5): M019 `[DOC]` не имеет входящих рёбер. | Добавить `M009 → M019` (doc после первого канала, как M018). |
| F12 | **LOW** | Logical consistency | **Plan §Constitution Check overreach** (plan.md, analyze F1): plan маркирует compliance как "NON-NEGOTIABLE" инвариант, но constitution v1.4.0 не содержит такого принципа. Feature-requirement = OK, но "NON-NEGOTIABLE" = governance-уровень. | Переформулировать: compliance = feature-level requirement с забастовочным весом (бан продавца = бизнес-критично), но не constitution-принцип. Или провести через `/speckit.constitution` если нужен governance-статус. |

## Alternative approaches considered

1. **Per-adapter policy (fallback if cross-spec 004 coordination fails)**: вместо shared `policy-engine` в core, каждый marketplace-адаптер проверяет свой policy перед OUTBOUND send. Про: нет зависимости от 004. Контра: 3 копии compliance-логики = drift risk, не зовётся из 004 гейта (двойная проверка потеряна). Приемлемо как stopgap, не как v1.

2. **LLM-judge-only policy (no regex)**: вместо regex prefilter → всегда LLM-judge. Про: ловит семантические обходы. Контра: +1 LLM call на каждый marketplace outbound (latency + cost), LLM judge сам ненадёжен (false negatives). Гибрид (F2) = лучший баланс.

3. **Chat discovery via webhook-only**: вместо polling, подписаться на все уведомления через webhook. Про: нет polling overhead. Контра: Ozon/WB могут не давать webhook на новые чаты (не верифицировано, M008). Если webhook есть — идеально, но spec не может на это рассчитывать.

## VERDICT

```yaml
verdict: HIGH
reviewer: glm
reviewed_at: 2026-06-09T18:45:00+03:00
commit: 9e30d79147fca33e4a843e450f2f0d322244c1df
critical_count: 1
high_count: 3
medium_count: 4
low_count: 4
notes: >
  CRITICAL: cross-spec deadlock (003/004/009) без fallback — повторяет паттерн 015-F2
  (reengagement bypass), но с тремя зависимостями вместо одной.
  HIGH: regex-only policy insufficient для compliance; chat discovery model undefined;
  MarketplaceContext routing gap в pipeline.
  Recommend: address F1 (fallback), F2 (hybrid policy), F3 (discovery), F4 (routing)
  before implement.
```
