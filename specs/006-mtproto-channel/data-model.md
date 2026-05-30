# Data Model: 006 MTProto Channel

This feature introduces no new database tables. The session state is managed by the Product layer (`ai-twins/specs/mtproto-session`). The `packages/channel-telegram-mtproto` module operates ephemerally in memory using the provided session string.

## In-Memory Structures

### `MTProtoChannelOptions`
```typescript
interface MTProtoChannelOptions {
  apiId: number;
  apiHash: string;
  sessionString: string;
  allowedChats?: (string | number)[]; // Whitelist for message processing
  typingIntervalMs?: number; // Default: 4000
}
```

### `TwinChannel` Instance
Maintains the active `TelegramClient` connection and internal state for rate-limiting logic.
- `client: TelegramClient`
- `typingTimers: Map<string, NodeJS.Timeout>`
- `rateLimitQueue: Map<string, MessageQueue>`
