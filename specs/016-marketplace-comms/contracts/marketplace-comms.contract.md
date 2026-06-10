# Contracts — Marketplace Customer-Comms (016)

> Reuses 015 `ChannelAdapter`. Adds marketplace metadata, policy-engine, order-API.

## 1. Marketplace adapter (extends 015 `ChannelAdapter`)
```ts
interface MarketplaceAdapter extends ChannelAdapter {
  inboundMode: 'webhook' | 'poll';            // CL-016-2
  // connect/disconnect/onIncoming/send/health — из 015
  // onIncoming публикует ChannelMessage с marketplaceContext (см. data-model)
}
```
- **Ozon**: `POST /v1/chat/start`, `POST /v1/chat/send/message` (auth `Client-Id`+`Api-Key`); chat↔posting.
- **WB**: `buyer-chat-api.wildberries.ru` (чат заказа) + Questions/Reviews (`nmId`); лимит 1 req/s.
- send → REST; ack после успеха (015 R6). poll → backoff; webhook → подпись+идемпотентность (015 FR-006).

## 2. policy-engine (shared, hybrid — CL-016-3 / glm-F2)
```ts
interface PolicyEngine {
  // Гибрид (FR-004a): regex prefilter → LLM-judge на low-confidence.
  check(text: string, profile: PolicyProfile): Promise<PolicyResult>;
}
type PolicyResult = {
  allowed: boolean;
  violations: string[];
  confidence: number;          // < profile.judgeThreshold → был вызван LLM-judge
  redactedText?: string;       // ТОЛЬКО для явных contacts/phone (regex-clean), НЕ для семантики (FR-004d)
};
type PolicyProfile = {
  marketplace: 'ozon' | 'wb' | 'yandex';
  forbiddenPatterns: string[];                 // regex prefilter
  rules: { offPlatformRedirect: boolean; contactExchange: boolean; externalLinks: boolean };
  judgeModel: string;                          // LLM-judge для семантических обходов
  judgeThreshold: number;
};
// Зовут: валидаторы 004 (outbound-гейт, FR-004b — post-generation, любой источник) И marketplace-канал.
// Violation → block + regenerate (макс 2 попытки → silent block + audit), НЕ redact семантики (FR-004d).
```

## 2a. MarketplaceRegistry (fail-closed boot — gemini-F1 / FR-004c)
```ts
interface MarketplaceRegistry {
  // Вызывается ДО adapter.connect(): нет валидного PolicyProfile для channelType → throw, канал не стартует.
  assertPolicyProfile(channelType: ChannelType): void;
}
```

## 3. order-API client (FR-010)
```ts
interface OrderApiClient {
  getOrderContext(orderId: string): Promise<OrderContext | null>; // null → degrade (отвечаем по тексту)
}
// per-marketplace (ozon-order, wb-order); кэш Redis TTL; рейт-лимит.
```

## 4. Compliance gating (engine-level — FR-005)
```ts
function isMarketplace(t: ChannelType): boolean; // ozon|wb|yandex
// reengagement(009): scan SKIP if isMarketplace(conv.channelType)
// funnel(003): no redirect-stages if isMarketplace(channelType)
```

## 5. INBOUND/OUTBOUND payload + context persistence (015 + marketplaceContext)
INBOUND: `{ …015, marketplaceContext }`. OUTBOUND: `{ …015, marketplaceContext }`.
**Routing/persistence (glm-F4 / FR-012)**: LLM-результат НЕ содержит `chatId`/`questionId`, поэтому
оркестратор ОБЯЗАН **персистить** `marketplaceContext` из INBOUND в conversation-store (или Redis
`mpctx:<conversationId>`, TTL) и **достать** его при OUTBOUND publish — иначе адаптер не знает, куда
слать ответ. Outbound ОБЯЗАН пройти валидаторы 004 + `policy-engine` (post-generation, FR-004b).

## 6. PolicyBlockEvent (audit — glm-F8 / FR-011)
```ts
type PolicyBlockEvent = {
  timestamp: string; tenantId: string; channelType: ChannelType; marketplace: string;
  conversationId: string; messageId: string; violations: string[];
  action: 'blocked' | 'redacted' | 'regenerated';   // originalText — encrypted/redacted (Standing Order 4)
};
// Retention 90 дней (доказательство фильтрации при бан-споре).
```
