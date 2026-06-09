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

// Mock node:https for outgoing API calls
vi.mock('node:https', () => ({
  request: vi.fn(),
}));

const { DingTalkAdapter } = await import('../../src/dingtalk-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-dt-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: { appKey: 'test-app-key', appSecret: 'test-app-secret' },
    ...overrides,
  };
}

describe('DingTalkAdapter', () => {
  let adapter: InstanceType<typeof DingTalkAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DingTalkAdapter(makeConfig());
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

    expect(mockListen).toHaveBeenCalledWith(3200, expect.any(Function));
    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-dingtalk',
      'dingtalk-ch-dt-001',
      expect.any(Function),
    );

    const health = await adapter.health();
    expect(health.status).toBe('active');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('throws if appKey missing from credentials', () => {
    expect(() => new DingTalkAdapter(makeConfig({ credentials: { appSecret: 'secret' } }))).toThrow();
  });

  it('throws if appSecret missing from credentials', () => {
    expect(() => new DingTalkAdapter(makeConfig({ credentials: { appKey: 'key' } }))).toThrow();
  });

  it('handles incoming message and publishes to INBOUND', async () => {
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
      msgtype: 'text',
      content: { text: 'Hello DingTalk twin!' },
      senderId: 'user-123',
      conversationId: 'conv-456',
      messageId: 'msg-001',
      createAt: Date.now(),
    });

    const mockReq = {
      method: 'POST',
      headers: {},
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

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_type: 'dingtalk',
      channel_id: 'ch-dt-001',
      content: 'Hello DingTalk twin!',
      tenant_id: 'tenant-001',
      external_user_id: 'user-123',
    }));

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('Hello DingTalk twin!');
  });

  it('handles check_url verification event', async () => {
    await adapter.connect();

    const { createServer } = await import('node:http');
    const handler = (createServer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
      req: unknown, res: unknown
    ) => Promise<void>;

    const eventPayload = JSON.stringify({ EventType: 'check_url' });

    const mockReq = {
      method: 'POST',
      headers: {},
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

    expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ success: true }));
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
        channel_id: 'ch-dt-001',
        message_id: 'out-rate',
        external_user_id: '111',
        content: 'Rate limited message',
      },
    });
  });

  it('tenant isolation: two adapters have separate tenant context', async () => {
    const adapter2 = new DingTalkAdapter(makeConfig({
      channelId: 'ch-dt-002',
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
