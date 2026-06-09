# Adding a New Channel Adapter

This guide walks you through implementing a new channel adapter in UndreCreaITwins. Every messaging platform (Discord, Slack, Telegram, WhatsApp, etc.) is backed by a **channel adapter** — a standalone process that implements the `ChannelAdapter` contract and bridges messages between the platform and the internal Redis-stream message bus.

---

## 1. The ChannelAdapter Contract

Every adapter must implement the `ChannelAdapter` interface defined in `@undrecreaitwins/shared`:

```typescript
// packages/shared/src/types.ts
interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void;
  send(message: ChannelMessage): Promise<void>;
  health(): Promise<ChannelHealth>;
}
```

**Method summary:**

| Method | Purpose |
|---|---|
| `connect()` | Open the platform connection (WebSocket, HTTP server, bot login, etc.) and start the outbound consumer loop. |
| `disconnect()` | Gracefully close the platform connection and Redis transport. Set status to `'disconnected'`. |
| `onIncoming(handler)` | Register a handler the adapter calls when an inbound message arrives from the platform. |
| `send(message)` | Deliver a single outbound `ChannelMessage` to the platform user/channel. Must update `_status` to `'error'` on failure. |
| `health()` | Return a `ChannelHealth` snapshot: `{ status, lastPingAt?, error?, uptimeSeconds? }`. |

**Supporting types:**

```typescript
type ChannelStatus = 'active' | 'degraded' | 'disconnected' | 'error';

interface ChannelHealth {
  status: ChannelStatus;
  lastPingAt?: Date;
  error?: string;
  uptimeSeconds?: number;
}

interface ChannelMessage {
  id: string;
  channelId: string;
  externalUserId: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
  attachments?: ChannelAttachment[];
  typing?: boolean;
  replyAnchor?: { externalMessageId: string };
}

interface ChannelAttachment {
  kind: 'image' | 'audio' | 'video' | 'file';
  url?: string;
  bytes?: Buffer;
  mime: string;
  filename?: string;
}
```

---

## 2. Step-by-step: Create a New Channel Package

### 2.1 Scaffold the package directory

```
packages/channel-<name>/
  src/
    <name>-adapter.ts    # Your adapter class
    index.ts             # CLI entry point (process runner)
  tests/
    integration/
      <name>-adapter.test.ts
  tsconfig.json
  package.json
```

### 2.2 Copy and adapt `package.json`

Use an existing channel (e.g., `channel-discord`) as a template:

```json
{
  "name": "@undrecreaitwins/channel-<name>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "twin-<name>": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "validate": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@undrecreaitwins/shared": "workspace:*",
    "@undrecreaitwins/core": "workspace:*",
    "ioredis": "^5.4.0",
    "pino": "^9.6.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

Add your platform-specific SDK (e.g., `discord.js`, `@slack/web-api`) to `dependencies`.

### 2.3 Copy `tsconfig.json`

This is identical across all channel packages:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 3. Implement the Adapter Class

### 3.1 Constructor pattern

Every adapter receives a uniform config object and must store `tenantId` and `personaSlug` for message stamping:

```typescript
import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import pino from 'pino';

const logger = pino({ name: '<name>-adapter' });

export class MyAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    // Validate required credentials
    const apiToken = config.credentials['apiToken'];
    if (typeof apiToken !== 'string' || apiToken.length === 0) {
      throw new AppError('apiToken is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    // ...initialize platform client...
  }
```

### 3.2 Tenant/persona stamping on every inbound message

**Every inbound message must include `tenant_id` and `persona_slug`** in the Redis stream payload. This is how the orchestrator routes messages to the correct persona and enforces tenant isolation:

```typescript
await this.transport.publish(REDIS_STREAMS.INBOUND, {
  channel_type: '<name>',
  channel_id: this.channelId,
  message_id: message.id,
  persona_slug: this.personaSlug,   // ← required
  content: message.content,
  tenant_id: this.tenantId,          // ← required
  external_user_id: message.externalUserId,
});
```

If either field is missing, the message will be dropped by the orchestrator.

### 3.3 The `connect()` method

```typescript
async connect(): Promise<void> {
  // 1. Establish platform connection (login, open socket, start HTTP server, etc.)
  // 2. Start the outbound consumer loop
  this.startOutboundConsumer();
  // 3. Set status
  this._status = 'active';
  logger.info({ channelId: this.channelId, tenantId: this.tenantId }, '<name> adapter connected');
}
```

### 3.4 The `disconnect()` method

```typescript
async disconnect(): Promise<void> {
  // 1. Close platform connection
  // 2. Close Redis transport
  await this.transport.disconnect();
  this._status = 'disconnected';
  logger.info({ channelId: this.channelId }, '<name> adapter disconnected');
}
```

### 3.5 The `onIncoming()` method

```typescript
onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
  this.incomingHandler = handler;
}
```

### 3.6 The `send()` method

```typescript
async send(message: ChannelMessage): Promise<void> {
  try {
    // Deliver message to platform using its API
  } catch (err) {
    this._status = 'error';
    logger.error({ err, channelId: this.channelId }, '<name> send failed');
    throw err;
  }
}
```

### 3.7 The `health()` method

```typescript
async health(): Promise<ChannelHealth> {
  return {
    status: this._status,
    uptimeSeconds: process.uptime(),
  };
}
```

---

## 4. Inbound Modes: Persistent Connection vs. Webhook

Adapters fall into two categories based on how they receive messages from the platform.

### 4.1 Bot/Socket mode (persistent connection)

For platforms where you connect as a bot or maintain a persistent WebSocket (Discord, Telegram, Matrix):

- The adapter opens a long-lived connection during `connect()`.
- Incoming messages arrive as events on the platform SDK client.
- Map each event to a `ChannelMessage`, publish to `REDIS_STREAMS.INBOUND`, and call `incomingHandler`.
- **Examples:** `channel-discord`, `channel-telegram`, `channel-matrix`

```typescript
// In connect():
this.client.on('message', (msg) => this.handleMessage(msg));

// In handleMessage():
private async handleMessage(msg: PlatformMessage): Promise<void> {
  const message: ChannelMessage = { /* map fields */ };
  await this.transport.publish(REDIS_STREAMS.INBOUND, { /* stamped payload */ });
  if (this.incomingHandler) {
    await this.incomingHandler(message);
  }
}
```

### 4.2 Webhook mode (HTTP server + signature verification)

For platforms that push events to you via HTTP POST (Slack, DingTalk, Feishu, WeCom, Home Assistant):

- The adapter starts an HTTP server in `connect()`.
- Each POST request is a webhook delivery.
- **Always verify the signature** before processing the payload.
- Use `verifyGenericWebhookSignature()` from `@undrecreaitwins/core/services/webhook-signature.js` for platforms with standard HMAC-SHA256 signatures.
- For platform-specific verification, implement it directly (see `channel-slack` for Slack's v0 signing scheme).

```typescript
import { createServer } from 'node:http';
import { verifyGenericWebhookSignature } from '@undrecreaitwins/core/services/webhook-signature.js';

// In constructor:
this.server = createServer((req, res) => this.handleRequest(req, res));

// Request handler:
private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }

  const body = await this.readBody(req);
  const signature = req.headers['x-signature'] as string | undefined;

  if (!signature || !verifyGenericWebhookSignature(body, signature, this.webhookSecret)) {
    res.writeHead(401).end(JSON.stringify({ error: 'invalid_signature' }));
    return;
  }

  const payload = JSON.parse(body) as Record<string, unknown>;
  // ... parse platform-specific event, build ChannelMessage, publish to INBOUND ...
  res.writeHead(200).end();
}
```

---

## 5. Shared Services

### 5.1 ChannelTransport — Redis stream pub/sub

The `ChannelTransport` class wraps Redis Streams for reliable message delivery between adapters and the orchestrator.

**Inbound publishing** (adapter → orchestrator):

```typescript
import { ChannelTransport } from '@undrecreaitwins/core/services/channel-transport.js';
import { REDIS_STREAMS } from '@undrecreaitwins/shared';

const transport = new ChannelTransport(); // uses REDIS_URL env var

await transport.publish(REDIS_STREAMS.INBOUND, {
  channel_type: 'discord',
  channel_id: 'ch-001',
  message_id: 'msg-001',
  persona_slug: 'my-persona',
  content: 'Hello!',
  tenant_id: 'tenant-001',
  external_user_id: 'user-001',
});
```

**Outbound consumption** (orchestrator → adapter):

```typescript
const consumerName = `discord-${this.channelId}`;
this.transport.consume(
  REDIS_STREAMS.OUTBOUND,
  'channel-discord',     // consumer group name
  consumerName,          // consumer name (unique per adapter instance)
  async (msg: StreamMessage) => {
    // Filter: only process messages for this channel
    if (msg.data.channel_id !== this.channelId) return;

    // Rate limit check
    const rateCheck = channelRateLimiter.check('discord', {
      content: msg.data.content ?? '',
    });
    if (!rateCheck.allowed) {
      logger.warn({ reason: rateCheck.reason }, 'Rate limit exceeded');
      return;
    }

    // Send to platform
    await this.send({
      id: msg.data.message_id ?? '',
      channelId: this.channelId,
      externalUserId: msg.data.external_user_id ?? '',
      content: msg.data.content ?? '',
      timestamp: new Date(),
    });
  },
);
```

The `consume()` method uses a consumer group for reliable delivery. Messages that fail processing are not acknowledged and will be redelivered. It auto-retries with exponential backoff on stream errors (up to `maxRetries`, default 5).

**Cleanup:** Always call `transport.disconnect()` in your adapter's `disconnect()` method.

### 5.2 channelRateLimiter — rate limiting before sends

Every adapter **must** call `channelRateLimiter.check()` before sending an outbound message. The rate limiter enforces per-platform limits on message frequency, content length, and media size:

```typescript
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';

const rateCheck = channelRateLimiter.check('discord', {
  content: message.content,
  mediaSizeBytes: 1024, // optional
});

if (!rateCheck.allowed) {
  logger.warn({ reason: rateCheck.reason }, 'Rate limit exceeded');
  return; // do not send
}
```

Platform limits are defined in `packages/core/src/services/channel-rate-limiter.ts`:

| Platform | Msg/sec | Max length | Max media |
|---|---|---|---|
| telegram | 30 | 4,096 | 50 MB |
| whatsapp_evolution | 5 | 65,536 | 64 MB |
| discord | 5 | 2,000 | 25 MB |
| slack | 1 | 40,000 | 1 MB |
| mattermost | 10 | 16,383 | 50 MB |
| dingtalk | 5 | 20,000 | 20 MB |
| feishu | 5 | 4,096 | 30 MB |
| wecom | 5 | 2,048 | 20 MB |
| matrix | 10 | 65,536 | 100 MB |
| email | 1 | 1,000,000 | 25 MB |
| sms | 1 | 1,600 | 0 |
| webhook | 100 | 1,000,000 | 100 MB |
| homeassistant | 10 | 50,000 | 10 MB |

If your new platform isn't in the table, the default limits apply: 100 msg/sec, 1M chars, 100 MB media.

### 5.3 verifyGenericWebhookSignature — webhook signature verification

For webhook-mode adapters, use this helper to verify HMAC-SHA256 signatures:

```typescript
import { verifyGenericWebhookSignature } from '@undrecreaitwins/core/services/webhook-signature.js';

const valid = verifyGenericWebhookSignature(rawBody, signatureHeader, webhookSecret);
```

It handles the `sha256=` prefix stripping automatically and uses timing-safe comparison to prevent timing attacks.

For platforms with custom signature schemes (e.g., Slack's `v0:` prefix, Feishu's `timestamp+nonce+body`), implement verification directly. See `packages/core/src/services/webhook-signature.ts` for helpers like `verifyFeishuSignature` and `verifyWeComSignature`.

---

## 6. The Outbound Consumer Pattern

Every adapter must consume from `REDIS_STREAMS.OUTBOUND` (the `twin.stream.out` Redis stream) to receive messages the orchestrator wants to deliver to the platform. This is started in `connect()`:

```typescript
private startOutboundConsumer(): void {
  const consumerName = `<name>-${this.channelId}`;
  this.transport.consume(
    REDIS_STREAMS.OUTBOUND,
    `channel-<name>`,   // group name — same for all instances of this adapter type
    consumerName,        // consumer name — unique per adapter instance
    async (msg: StreamMessage) => {
      if (msg.data.channel_id !== this.channelId) return;

      const rateCheck = channelRateLimiter.check('<name>', {
        content: msg.data.content ?? '',
      });
      if (!rateCheck.allowed) {
        logger.warn({ reason: rateCheck.reason, channelId: this.channelId }, 'Rate limit exceeded');
        return;
      }

      await this.send({
        id: msg.data.message_id ?? '',
        channelId: this.channelId,
        externalUserId: msg.data.external_user_id ?? '',
        content: msg.data.content ?? '',
        timestamp: new Date(),
      });
    },
  ).catch(() => {
    this._status = 'error';
  });
}
```

**Key points:**
- Always filter by `channel_id` — the outbound stream is shared across all adapters.
- Always call `channelRateLimiter.check()` before sending.
- Catch errors on the consume promise and set `_status = 'error'`.

---

## 7. The CLI Entry Point (`index.ts`)

Each adapter is a standalone process. The `index.ts` entry point parses CLI arguments and starts the adapter:

```typescript
import { MyAdapter } from './my-adapter.js';

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const channelId = getArg('channel-id');
const redisUrl = getArg('redis-url');
const tenantId = getArg('tenant-id');
const personaSlug = getArg('persona-slug');
const credentialsJson = getArg('credentials');

if (!channelId || !tenantId || !personaSlug) {
  console.error('Required: --channel-id, --tenant-id, --persona-slug');
  process.exit(1);
}

const credentials = credentialsJson ? JSON.parse(credentialsJson) : {};

const adapter = new MyAdapter({
  channelId,
  tenantId,
  personaSlug,
  redisUrl,
  credentials,
});

process.on('SIGINT', async () => {
  await adapter.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await adapter.disconnect();
  process.exit(0);
});

adapter.connect().catch((err) => {
  console.error('Failed to start <name> adapter:', err);
  process.exit(1);
});
```

Run it:

```bash
node dist/index.js \
  --channel-id "ch-001" \
  --tenant-id "tenant-001" \
  --persona-slug "my-persona" \
  --redis-url "redis://localhost:6379" \
  --credentials '{"apiToken":"..."}'
```

---

## 8. Testing Requirements

All tests use **vitest**. Follow the pattern from existing channel adapters.

### 8.1 Unit/integration test structure

```typescript
// tests/integration/<name>-adapter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelMessage } from '@undrecreaitwins/shared';

// Mock ChannelTransport
const mockPublish = vi.fn().mockResolvedValue('0-0');
const mockConsume = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

vi.mock('@undrecreaitwins/core/services/channel-transport.js', () => ({
  ChannelTransport: vi.fn().mockImplementation(() => ({
    publish: mockPublish,
    consume: mockConsume,
    disconnect: mockDisconnect,
  })),
}));

// Mock rate limiter
vi.mock('@undrecreaitwins/core/services/channel-rate-limiter.js', () => ({
  channelRateLimiter: {
    check: vi.fn().mockReturnValue({ allowed: true }),
  },
}));

// Mock platform SDK
vi.mock('my-platform-sdk', () => ({
  PlatformClient: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  })),
}));

const { MyAdapter } = await import('../../src/my-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-test-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: { apiToken: 'test-token' },
    ...overrides,
  };
}

describe('MyAdapter', () => {
  let adapter: InstanceType<typeof MyAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new MyAdapter(makeConfig());
  });

  afterEach(async () => {
    try { await adapter.disconnect(); } catch { /* already disconnected */ }
  });

  it('connects and reports active health', async () => {
    await adapter.connect();
    const health = await adapter.health();
    expect(health.status).toBe('active');
  });

  it('throws if required credentials are missing', () => {
    expect(() => new MyAdapter(makeConfig({ credentials: {} }))).toThrow();
  });

  it('publishes inbound messages with tenant_id and persona_slug', async () => {
    // ... simulate inbound message, verify transport.publish called with
    //     tenant_id and persona_slug in the payload
  });

  it('consumes outbound messages filtered by channel_id', async () => {
    // ... verify consume callback filters correctly
  });

  it('respects rate limiter rejection', async () => {
    // ... mock rateLimiter.check to return { allowed: false },
    //     verify send() is NOT called
  });

  it('sets status to error on send failure', async () => {
    // ... mock platform to throw, verify _status === 'error'
  });

  it('disconnects cleanly', async () => {
    await adapter.connect();
    await adapter.disconnect();
    const health = await adapter.health();
    expect(health.status).toBe('disconnected');
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
```

### 8.2 Required test cases

Every adapter must have tests covering:

1. **Construction with valid credentials** — adapter creates without error.
2. **Missing/invalid credentials** — constructor throws `AppError`.
3. **Connect** — status becomes `'active'`, outbound consumer starts.
4. **Disconnect** — status becomes `'disconnected'`, platform client and transport closed.
5. **Inbound message flow** — platform message is mapped to `ChannelMessage`, published to `REDIS_STREAMS.INBOUND` with `tenant_id` and `persona_slug`.
6. **Outbound message flow** — consumer callback filters by `channel_id`, checks rate limit, calls `send()`.
7. **Rate limiter enforcement** — when `check()` returns `{ allowed: false }`, the message is not sent.
8. **Send failure** — `send()` failure sets status to `'error'`.
9. **Health** — returns correct `ChannelHealth` for each status state.
10. **Tenant isolation** — two adapter instances with different tenants do not cross-contaminate.

---

## 9. Deployment

Each adapter runs as a **separate process**. This provides:

- **Isolation:** A crash in one adapter doesn't affect others.
- **Independent scaling:** High-traffic channels can run multiple instances.
- **Flexible deployment:** Different adapters can run on different machines.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `REDIS_URL` | Yes | Redis connection URL for transport and health checks. |
| Platform-specific | Yes | API tokens, webhook secrets, etc. (passed via `--credentials`). |

### Health monitoring

Each adapter writes its health status to Redis key `channels:health:{channelId}`. The API endpoint `GET /v1/channels/health` aggregates these per-tenant with a 30-second cache. The health API returns:

```json
{
  "channels": {
    "ch-001": { "status": "active", "lastPingAt": "2026-06-09T10:00:00Z" },
    "ch-002": { "status": "error", "error": "Connection refused" }
  },
  "overall": "degraded"
}
```

Overall status is:
- `'healthy'` — all channels active.
- `'degraded'` — at least one channel is non-active, but not all are down.
- `'down'` — all channels are in error state.

---

## 10. Minimal Adapter Skeleton

Here is a complete, minimal adapter you can use as a starting point. It implements a generic webhook channel:

```typescript
// packages/channel-example/src/example-adapter.ts
import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import { verifyGenericWebhookSignature } from '@undrecreaitwins/core/services/webhook-signature.js';
import pino from 'pino';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

const logger = pino({ name: 'example-adapter' });

export class ExampleAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private webhookSecret: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private server: Server;
  private port: number;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const webhookSecret = config.credentials['webhookSecret'];
    if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
      throw new AppError('webhookSecret is required', 400, 'INVALID_CREDENTIALS');
    }

    this.webhookSecret = webhookSecret;
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.port = typeof config.credentials['port'] === 'number'
      ? config.credentials['port']
      : 3200;

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const body = await this.readBody(req);
    const signature = req.headers['x-signature-256'] as string | undefined
      ?? req.headers['x-signature'] as string | undefined;

    if (!signature || !verifyGenericWebhookSignature(body, signature, this.webhookSecret)) {
      logger.warn({ channelId: this.channelId }, 'Webhook signature verification failed');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_signature' }));
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      res.writeHead(400).end();
      return;
    }

    const message: ChannelMessage = {
      id: (payload['id'] as string) ?? String(Date.now()),
      channelId: this.channelId,
      externalUserId: (payload['user_id'] as string) ?? 'unknown',
      content: (payload['text'] as string) ?? '',
      timestamp: new Date(),
      metadata: payload,
    };

    await this.transport.publish(REDIS_STREAMS.INBOUND, {
      channel_type: 'example',
      channel_id: this.channelId,
      message_id: message.id,
      persona_slug: this.personaSlug,
      content: message.content,
      tenant_id: this.tenantId,
      external_user_id: message.externalUserId,
    });

    if (this.incomingHandler) {
      await this.incomingHandler(message);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.listen(this.port, () => {
        logger.info({ port: this.port, channelId: this.channelId }, 'Example HTTP server listening');
        resolve();
      });
      this.server.on('error', reject);
    });

    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Example adapter connected');
  }

  private startOutboundConsumer(): void {
    const consumerName = `example-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-example',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('webhook', {
          content: msg.data.content ?? '',
        });
        if (!rateCheck.allowed) {
          logger.warn({ reason: rateCheck.reason, channelId: this.channelId }, 'Rate limit exceeded');
          return;
        }

        await this.send({
          id: msg.data.message_id ?? '',
          channelId: this.channelId,
          externalUserId: msg.data.external_user_id ?? '',
          content: msg.data.content ?? '',
          timestamp: new Date(),
        });
      },
    ).catch(() => {
      this._status = 'error';
    });
  }

  async disconnect(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'Example adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    // Replace with actual platform API call
    logger.info(
      { channelId: this.channelId, externalUserId: message.externalUserId, contentLength: message.content.length },
      'Example send (stub)',
    );
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
    };
  }
}
```

---

## Checklist

Before submitting a new channel adapter, verify:

- [ ] Package directory follows `packages/channel-<name>/` convention.
- [ ] `package.json` has correct workspace dependencies (`@undrecreaitwins/shared`, `@undrecreaitwins/core`).
- [ ] Adapter class implements all 5 `ChannelAdapter` methods.
- [ ] Every inbound message is published with `tenant_id` and `persona_slug`.
- [ ] Outbound consumer filters by `channel_id` and calls `channelRateLimiter.check()`.
- [ ] Webhook adapters verify signatures with `verifyGenericWebhookSignature` or platform-specific verification.
- [ ] `_status` transitions correctly: `disconnected` → `active` (on connect), `active` → `error` (on failure), * → `disconnected` (on disconnect).
- [ ] Logger uses pino (no `console.log`).
- [ ] No `as any` type casts in production code.
- [ ] Tests cover all 10 required test cases using vitest.
- [ ] `tsconfig.json` matches the shared config (strict mode, NodeNext modules).
- [ ] CLI entry point (`index.ts`) handles SIGINT/SIGTERM for graceful shutdown.
- [ ] Channel type is added to the `ChannelType` union in `packages/shared/src/types.ts`.
- [ ] Channel type is added to `ALL_CHANNEL_TYPES` in `packages/api/src/routes/channels.ts`.
- [ ] Platform limits are added to `PLATFORM_LIMITS` in `packages/core/src/services/channel-rate-limiter.ts` (if different from defaults).
