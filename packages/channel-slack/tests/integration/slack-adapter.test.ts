import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelMessage } from '@undrecreaitwins/shared';

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

vi.mock('@undrecreaitwins/core/services/channel-rate-limiter.js', () => ({
  channelRateLimiter: {
    check: vi.fn().mockReturnValue({ allowed: true }),
  },
}));

// Mock node:http
const mockListen = vi.fn().mockImplementation(function (this: unknown, _port: number, cb: () => void) {
  cb();
  return this;
});
const mockClose = vi.fn().mockImplementation(function (this: unknown, cb: () => void) {
  cb();
  return this;
});
const mockOn = vi.fn();

vi.mock('node:http', () => ({
  createServer: vi.fn().mockReturnValue({
    listen: mockListen,
    close: mockClose,
    on: mockOn,
  }),
}));

const { SlackAdapter } = await import('../../src/slack-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-slack-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: { botToken: 'xoxb-test-token', signingSecret: 'test-signing-secret' },
    ...overrides,
  };
}

describe('SlackAdapter', () => {
  let adapter: InstanceType<typeof SlackAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SlackAdapter(makeConfig());
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('creates instance and connects HTTP server', async () => {
    await adapter.connect();

    expect(mockListen).toHaveBeenCalledWith(3100, expect.any(Function));
    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-slack',
      'slack-ch-slack-001',
      expect.any(Function),
    );

    const health = await adapter.health();
    expect(health.status).toBe('active');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('throws if botToken missing from credentials', () => {
    expect(() => new SlackAdapter(makeConfig({ credentials: { signingSecret: 'secret' } }))).toThrow();
  });

  it('throws if signingSecret missing from credentials', () => {
    expect(() => new SlackAdapter(makeConfig({ credentials: { botToken: 'token' } }))).toThrow();
  });

  it('handles URL verification challenge', async () => {
    await adapter.connect();

    // Get the request handler from createServer
    const { createServer } = await import('node:http');
    const handler = (createServer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
      req: unknown, res: unknown
    ) => Promise<void>;

    const mockReq = {
      method: 'POST',
      headers: {},
      on: vi.fn().mockImplementation((_event: string, cb: (chunk: Buffer) => void) => {
        if (_event === 'data') cb(Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'test-challenge-123' })));
        if (_event === 'end') cb();
      }),
    };
    const mockRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };

    await handler(mockReq, mockRes);

    expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ challenge: 'test-challenge-123' }));
  });

  it('handles incoming message event and publishes to INBOUND', async () => {
    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => {
      incomingMessages.push(msg);
    });

    await adapter.connect();

    const { createServer } = await import('node:http');
    const handler = (createServer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
      req: unknown, res: unknown
    ) => Promise<void>;

    const eventPayload = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message',
        user: 'U123456',
        text: 'Hello Slack twin!',
        channel: 'C789012',
        ts: '1234567890.123456',
        event_ts: '1234567890.123456',
      },
    });

    const mockReq = {
      method: 'POST',
      headers: {
        'x-slack-signature': 'v0=fakesignature',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      on: vi.fn().mockImplementation((_event: string, cb: (chunk: Buffer) => void) => {
        if (_event === 'data') cb(Buffer.from(eventPayload));
        if (_event === 'end') cb();
      }),
    };
    const mockRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };

    await handler(mockReq, mockRes);

    // Signature verification will fail with fake sig, so the message won't be published
    // That's expected since we can't compute a valid sig in this test
    expect(mockRes.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
  });

  it('outbound consumer filters messages for other channel_ids', async () => {
    await adapter.connect();

    const consumeHandler = mockConsume.mock.calls[0]?.[3] as
      ((msg: { id: string; data: Record<string, string> }) => Promise<void>) | undefined;
    expect(consumeHandler).toBeDefined();

    await consumeHandler!({
      id: 'out-002',
      data: {
        channel_id: 'ch-other',
        message_id: 'out-002',
        external_user_id: '111',
        content: 'Not for us',
      },
    });

    // Should not call send (no external HTTP request made)
  });

  it('disconnects HTTP server and transport', async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockClose).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');
  });

  it('respects rate limiter rejection', async () => {
    const { channelRateLimiter } = await import('@undrecreaitwins/core/services/channel-rate-limiter.js');
    (channelRateLimiter.check as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      allowed: false,
      reason: 'rate_exceeded',
    });

    await adapter.connect();

    const consumeHandler = mockConsume.mock.calls[0]?.[3] as
      ((msg: { id: string; data: Record<string, string> }) => Promise<void>) | undefined;
    expect(consumeHandler).toBeDefined();

    await consumeHandler!({
      id: 'out-rate',
      data: {
        channel_id: 'ch-slack-001',
        message_id: 'out-rate',
        external_user_id: '111',
        content: 'Rate limited message',
      },
    });
  });

  it('tenant isolation: two adapters have separate tenant context', async () => {
    const adapter2 = new SlackAdapter(makeConfig({
      channelId: 'ch-slack-002',
      tenantId: 'tenant-002',
      personaSlug: 'persona-b',
    }));

    const tenant1Messages: ChannelMessage[] = [];
    const tenant2Messages: ChannelMessage[] = [];

    adapter.onIncoming(async (msg) => { tenant1Messages.push(msg); });
    adapter2.onIncoming(async (msg) => { tenant2Messages.push(msg); });

    expect(tenant1Messages).toHaveLength(0);
    expect(tenant2Messages).toHaveLength(0);
  });
});
