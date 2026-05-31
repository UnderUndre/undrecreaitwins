# Quickstart: 006 MTProto Channel

`@undrecreaitwins/channel-telegram-mtproto` — a **standalone** MTProto userbot adapter implementing the canonical `ChannelAdapter` (`@undrecreaitwins/shared`), bridging Telegram ↔ Engine over the shared Redis Streams `ChannelTransport`. Same process model as `@undrecreaitwins/channel-telegram` (Bot API) and `@undrecreaitwins/channel-whatsapp`.

## Installation

```bash
npm install @undrecreaitwins/channel-telegram-mtproto
```

## Running the adapter worker

```typescript
import { TelegramMtprotoAdapter } from '@undrecreaitwins/channel-telegram-mtproto';
import { ChannelTransport } from '@undrecreaitwins/core';

const transport = new ChannelTransport(redis);

const adapter = new TelegramMtprotoAdapter({
  channelId: 'tg-mtproto-tenantA-1',          // binds session ↔ tenant/persona
  apiId: Number(process.env.TELEGRAM_API_ID),
  secrets: {
    // resolve by handle at runtime — NEVER pass raw secrets around or log them (codex F4)
    getApiHash: (id) => productSecrets.apiHash(id),
    getSessionString: (id) => productSecrets.session(id),
  },
  transport,
  allowlist: { chats: ['@my_test_chat', '-100123456789'] },
  typingIntervalMs: 4000,
});

await adapter.connect();   // raises the MTProto client; starts inbound listener + outbound consumer
const h = await adapter.health(); // { status: 'active' | 'degraded' | 'disconnected' | 'error', ... }
```

### How messages flow (transport, not in-process callbacks)

- **Inbound**: the adapter applies the eligibility filter (ignore self/outgoing, edits, media-only, service, non-allowlisted), de-dupes by `{channelId, externalMessageId}`, maps to a canonical `ChannelMessage`, and **publishes** to `REDIS_STREAMS.INBOUND`. The Engine consumes it. `onIncoming(handler)` exists for tests/local wiring, but in production the adapter publishes to the transport itself.
- **Outbound**: the adapter **consumes** `REDIS_STREAMS.OUTBOUND` and calls `send()` with a canonical `ChannelMessage` (NOT `chatId`/`text`):

```typescript
await adapter.send({
  id: 'reply-1',
  channelId: 'tg-mtproto-tenantA-1',
  externalUserId: '123456789',  // normalized peer id
  content: 'Hello from Twin Engine!',
  timestamp: new Date(),
});
```

## Notes

- **Secrets**: `apiHash` / `sessionString` are bearer credentials — resolved by handle, encrypted at rest by Product, never logged (spec §4).
- **Rate limits**: FloodWait handled per the RPC error policy (spec §5) — short waits retried, >60s dropped with a rejection, DC-migration handled, account-wide flood trips a circuit breaker.
- **Idempotency**: duplicate updates from reconnect catch-up are de-duped by `{channelId, externalMessageId}` — no double replies (spec §7).
- **Typing**: internal — shown while a reply is pending; not a contract method (spec §8).
