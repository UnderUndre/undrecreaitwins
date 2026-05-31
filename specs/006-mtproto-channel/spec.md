# Спецификация 006: MTProto Channel (Telegram Userbot)

## 1. Описание

Адаптер для подключения Telegram-юзерботов к ядру (Engine) через **MTProto** (не Bot API). Цифровой двойник общается от лица реального пользователя.

**Топология (решение по codex F5): standalone-воркер** — как существующие `@undrecreaitwins/channel-telegram` (Bot API) и `@undrecreaitwins/channel-whatsapp`. Адаптер реализует **канонический** `ChannelAdapter` из `@undrecreaitwins/shared` и общается с ядром ТОЛЬКО через общий `ChannelTransport` (Redis Streams: publish INBOUND / consume OUTBOUND). Engine НЕ поднимает MTProto-клиент в своём процессе — изоляция падений, бэкпрешер, масштабирование как у других каналов. *(Embedded-вариант — осознанный выбор пользователя с обоснованием; по умолчанию — standalone.)*

## 2. Канонический контракт (codex F1)

006 НЕ изобретает свой `IChannelAdapter`. Реализует `ChannelAdapter` из `@undrecreaitwins/shared`:

```typescript
interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void;
  send(message: ChannelMessage): Promise<void>;
  health(): Promise<ChannelHealth>;
}
interface ChannelMessage { id; channelId; externalUserId; content; metadata?; timestamp: Date; }
```

Удалены кустарные `sendMessage(chatId, text)`, `setTyping`, `onMessage` и локальный `ChannelMessage { senderId; timestamp: number }`. Маппинг MTProto → canonical:

- `id` = id сообщения MTProto (строкой)
- `channelId` = id инстанса канала (опции)
- `externalUserId` = нормализованный peer-id отправителя
- `content` = текст (media-only — см. §6)
- `metadata` = `{ chatId, peerType, isOutgoing, isEdit, ... }`
- `timestamp` = `new Date(message.date * 1000)`

Полный контракт: `contracts/mtproto-channel.ts`.

## 3. Runtime topology & identity (codex F5, F8)

- Отдельный пакет-воркер **`@undrecreaitwins/channel-telegram-mtproto`** (НЕ `@ai-twins/*` — codex F8).
- **Inbound**: адаптер `publish` в `REDIS_STREAMS.INBOUND`; Engine консьюмит.
- **Outbound**: адаптер `consume` из `REDIS_STREAMS.OUTBOUND` (group `channel-telegram-mtproto`) → вызывает `send()`.
- Один процесс = одна userbot-сессия (один реальный аккаунт). Несколько аккаунтов = несколько воркеров. Падение воркера изолировано от core API.
- `channelId` биндит сессию ↔ tenant/persona; задаётся при старте воркера.

## 4. Жизненный цикл секретов (codex F4)

`apiHash` и `sessionString` — **bearer-креды реального аккаунта**. Запрещено принимать их сырыми в широких options, логировать или сериализовать.

- Адаптер получает только `channelId` + `apiId` + **`SecretResolver`** (резолвит `apiHash`/`sessionString` по handle в рантайме). Product владеет хранением.
- **At-rest**: Product хранит `sessionString` зашифрованным.
- **Redaction**: структурные логи/метрики/ошибки НИКОГДА не сериализуют `apiHash`/`sessionString` (ни целиком options).
- **Rotation/revocation**: явный logout/revoke flow; невалидная/протухшая сессия → typed `InvalidSessionError`, без ретрай-петли; health → `error`; сигнал Product.

## 5. Rate limits / RPC error policy (codex F3, gemini F1)

Не «queue 50, drop >60s» одной строкой, а таблица политики RPC-ошибок Telegram:

| Ошибка | Scope | Политика |
|--------|-------|----------|
| `FLOOD_WAIT_X` (X ≤ 60s) | per-peer | подождать X (retry-after из ошибки) → повтор; очередь per-peer, FIFO |
| `FLOOD_WAIT_X` (X > 60s) | per-peer | дропнуть, `send()` реджектится typed-ошибкой, лог warn; не копить |
| account-wide flood | account | circuit-breaker: пауза всех outbound, health → `degraded` |
| `PHONE_MIGRATE_X` / `NETWORK_MIGRATE_X` / `USER_MIGRATE_X` | DC | реконнект к нужному DC + ребайнд сессии + повтор (лимит попыток) |
| `AUTH_KEY_*` / session invalid | auth | `InvalidSessionError`, без ретраев, health → `error`, сигнал Product |
| прочие non-retryable | — | проброс typed-ошибки, health → `degraded` |

- Очередь outbound — per-peer, с `maxAge`; `send()` резолвится после успешной отправки или реджектится (ждущий знает исход).
- Typing-RPC троттлится отдельно от текстовых (не ест outbound-бюджет).

## 6. Inbound eligibility / loop prevention (codex F6)

Userbot видит ВСЁ (приватные, группы, каналы, свои исходящие, edits, service, media). Правила приёма:

- **Игнор своих исходящих** (`out`/self) — иначе reply-петля и сжигание токенов.
- Allowlist: `chats` + опц. `senders`; если задан `senders` — отправитель матчится И по чату, И по отправителю.
- **Edits** уже обработанных — игнор (не реобработка).
- **Media-only / пустой текст** — не публиковать как пустой `content`; политика: skip или описание в `metadata`.
- **Service-сообщения** (вступления, пины) — игнор.
- **Channel posts** (broadcast) — игнор, если не в allowlist явно.
- Единый нормализованный формат peer-id для `externalUserId`.

## 7. Resync / idempotency (codex F2, gemini F3)

Сейчас durable-стейта нет → на краше/нетсплите дропает/переобрабатывает апдейты или шлёт двойные ответы. Требуется:

- **Idempotency**: ключи обработанных `{channelId, externalMessageId}` в Redis (TTL ~24ч); дубликаты из catch-up/replay подавляются ДО публикации в INBOUND.
- **Update-state**: полагаемся на update-state/catch-up MTProto-библиотеки; персист `sessionString` (Product) сохраняет update-state между рестартами → реконнект делает catch-up, а не теряет окно.
- **Reconnect replay**: после реконнекта — catch-up; дедуп гасит повторы.
- **Gap handling**: при разрыве последовательности — лог + повторный запрос состояния (в пределах окна библиотеки).

## 8. Typing indicator (внутреннее)

В каноническом контракте нет `setTyping`. Печать — внутреннее поведение: старт при принятом inbound из allowed-чата, рефреш каждые `typingIntervalMs` (деф. 4000), стоп при отправке outbound или таймауте. Таймеры чистятся на `disconnect` (без leak). Не публичный метод контракта.

## 9. Функциональные требования

- **FR-001**: Реализовать **канонический** `ChannelAdapter` из `@undrecreaitwins/shared` (connect/disconnect/onIncoming/send/health). Локальный adapter-интерфейс запрещён. (codex F1)
- **FR-002**: Мост через `ChannelTransport` (Redis Streams): publish INBOUND / consume OUTBOUND; standalone-воркер. (codex F5)
- **FR-003**: Пакет **`@undrecreaitwins/channel-telegram-mtproto`**. (codex F8)
- **FR-004**: Секреты только через `SecretResolver`; at-rest шифрование (Product); redaction в логах; logout/revoke; `InvalidSessionError`. (codex F4)
- **FR-005**: RPC error policy (§5): FloodWait per-peer/account, retry-after, DC-migration, circuit-breaker, non-retryable. (codex F3)
- **FR-006**: Inbound eligibility (§6): игнор self/outgoing, edits, media-only, service, channel posts; allowlist chats+senders; нормализованный peer-id; loop-prevention. (codex F6)
- **FR-007**: Idempotency + resync (§7): dedup `{channelId, externalMessageId}`; reconnect catch-up; no double-reply. (codex F2)
- **FR-008**: Typing — внутреннее (§8), не метод контракта.
- **FR-009**: `health()` → `ChannelHealth` (active/degraded/disconnected/error). (codex F1)

## 10. Тесты (codex F7)

Не один тест (init+allowlist). Разбить по рискам:

- **Contract-compat**: реализует shared `ChannelAdapter` (типы сходятся), маппинг ChannelMessage корректен.
- **Protocol**: FloodWait ≤60s (retry), >60s (drop+reject), queue overflow, DC-migration retry, non-retryable error.
- **Recovery/idempotency**: дисконнект во время inbound и во время outbound; дубль inbound → ОДИН ответ; gap после реконнекта.
- **Secret handling**: ни лог/ошибка/сериализация options не содержит `apiHash`/`sessionString`; invalid session → `InvalidSessionError`.
- **Lifecycle**: typing-таймеры очищаются на disconnect (нет leak).
- **Eligibility**: own-outgoing игнор, media-only, edits, смешанный allowlist (chats+senders).

## 11. Связь с Product

Product (`ai-twins/specs/mtproto-session`) владеет логином (телефон/код/2FA), **зашифрованным** хранением `sessionString`, ротацией/ревокацией. Адаптеру отдаётся `channelId` + `SecretResolver` (handle), НЕ сырая сессия. (codex F4)
