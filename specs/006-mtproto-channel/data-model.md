# Data Model: 006 MTProto Channel

006 introduces **no new SQL tables**. Session login/storage is owned by the Product layer (`ai-twins/specs/mtproto-session`), **encrypted at rest** (codex F4). The adapter resolves secrets by handle via `SecretResolver` and never persists raw `apiHash` / `sessionString`.

## Durable state (codex F2 — NEW; none existed in the repo before)

To survive crash / network split without dropping or double-processing updates:

### Idempotency keys (Redis)

- Key: `mtproto:dedup:{channelId}` → set/hash of processed `externalMessageId`.
- TTL: ~24h (bounded). Checked **before** publishing inbound to the transport; duplicates from reconnect catch-up are suppressed → no double replies.

### Update state

- Relies on the MTProto library's internal update-state / catch-up. Persisting the `sessionString` (Product-owned) preserves update-state across restarts, so a reconnect performs catch-up rather than losing the window.
- No separate cursor table — the session IS the checkpoint; the dedup set guards replays.

## In-memory structures (per worker process)

```typescript
client: TelegramClient                       // single userbot session per worker
transport: ChannelTransport                  // Redis Streams: publish INBOUND / consume OUTBOUND
typingTimers: Map<string /*peerId*/, NodeJS.Timeout>   // cleared on disconnect (no leak)
outboundQueue: Map<string /*peerId*/, Queue> // per-peer FloodWait queue (maxAge, FIFO)
```

## Options (no raw secrets — codex F4)

```typescript
MtprotoAdapterOptions {
  channelId: string;
  apiId: number;
  secrets: SecretResolver;       // resolves apiHash/sessionString by handle
  transport: ChannelTransport;
  allowlist?: { chats?: string[]; senders?: string[] };
  typingIntervalMs?: number;     // default 4000
}
```

Full contract + the canonical `ChannelMessage` mapping: `contracts/mtproto-channel.ts`.
