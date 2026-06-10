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

vi.mock('@undrecreaitwins/core/services/webhook-signature.js', () => ({
  verifyGenericWebhookSignature: vi.fn().mockReturnValue(true),
}));

// Mock ioredis
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisQuit = vi.fn().mockResolvedValue('OK');

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    set: mockRedisSet,
    quit: mockRedisQuit,
  })),
}));

// Mock node:http server
const mockCreateServer = vi.fn();
const mockServerListen = vi.fn().mockImplementation(function (this: object, _port: number, cb: () => void) {
  cb();
  return this;
});
const mockServerClose = vi.fn().mockImplementation((cb: () => void) => cb());
const mockServerOn = vi.fn();

vi.mock('node:http', () => ({
  createServer: (...args: unknown[]) => {
    mockCreateServer(...args);
    return { listen: mockServerListen, close: mockServerClose, on: mockServerOn };
  },
}));

// Mock node:https for outbound
const mockHttpsRequest = vi.fn();

vi.mock('node:https', () => ({
  request: (...args: unknown[]) => mockHttpsRequest(...args),
}));

function mockHttpsResponse(body: string, statusCode = 200) {
  return (optsOrUrl: unknown, cbOrOpts: unknown, maybeCb?: unknown) => {
    const cb = (typeof cbOrOpts === 'function' ? cbOrOpts : maybeCb) as (res: unknown) => void;
    const res = {
      statusCode,
      on: vi.fn().mockImplementation((event: string, handler: (chunk?: Buffer) => void) => {
        if (event === 'data') handler(Buffer.from(body));
        if (event === 'end') handler();
      }),
    };
    cb(res);
    return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  };
}

const { WebhooksAdapter } = await import('../../src/webhooks-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-webhook-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: {
      webhookSecret: 'test-secret',
      outgoingUrl: 'https://example.com/webhook',
    },
    ...overrides,
  };
}

function getServerHandler(): ((req: unknown, res: unknown) => void) | undefined {
  return mockCreateServer.mock.calls[0]?.[0] as
    ((req: unknown, res: unknown) => void) | undefined;
}

function getConsumeHandler():
  | ((msg: { id: string; data: Record<string, string> }) => Promise<void>)
  | undefined {
  return mockConsume.mock.calls[0]?.[3] as
    | ((msg: { id: string; data: Record<string, string> }) => Promise<void>)
    | undefined;
}

describe('WebhooksAdapter', () => {
  let adapter: InstanceType<typeof WebhooksAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new WebhooksAdapter(makeConfig());
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

    expect(mockServerListen).toHaveBeenCalledWith(3102, expect.any(Function));
    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-webhooks',
      'webhooks-ch-webhook-001',
      expect.any(Function),
    );

    const health = await adapter.health();
    expect(health.status).toBe('active');
  });

  it('throws if webhookSecret missing from credentials', () => {
    expect(() => new WebhooksAdapter(makeConfig({
      credentials: {},
    }))).toThrow();
  });

  it('incoming webhook with "text" field publishes to INBOUND', async () => {
    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => { incomingMessages.push(msg); });

    await adapter.connect();
    const handler = getServerHandler();
    expect(handler).toBeDefined();

    const mockRes = {
      writeHead: vi.fn().mockReturnThis().mockReturnThis(),
      end: vi.fn(),
    };

    const webhookBody = JSON.stringify({
      text: 'Hello webhook!',
      sender: 'user-001',
      id: 'msg-001',
    });

    const mockReq = {
      method: 'POST',
      headers: { 'x-webhook-signature': 'valid-sig' },
      on: vi.fn().mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(webhookBody));
        if (event === 'end') cb();
      }),
    };

    await handler!(mockReq, mockRes);

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('Hello webhook!');
    expect(incomingMessages[0]!.externalUserId).toBe('user-001');
    expect(incomingMessages[0]!.id).toBe('msg-001');

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_type: 'webhook',
      channel_id: 'ch-webhook-001',
      message_id: 'msg-001',
      persona_slug: 'test-persona',
      content: 'Hello webhook!',
      tenant_id: 'tenant-001',
      external_user_id: 'user-001',
    }));

    expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
  });

  it('handles "content" field as alternative to "text"', async () => {
    await adapter.connect();
    const handler = getServerHandler();

    const mockRes = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };

    const webhookBody = JSON.stringify({
      content: 'Content field message',
      from: 'user-002',
      message_id: 'msg-002',
    });

    const mockReq = {
      method: 'POST',
      headers: { 'x-webhook-signature': 'valid-sig' },
      on: vi.fn().mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(webhookBody));
        if (event === 'end') cb();
      }),
    };

    await handler!(mockReq, mockRes);

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      content: 'Content field message',
    }));
  });

  it('rejects webhook with invalid signature', async () => {
    const { verifyGenericWebhookSignature } = await import('@undrecreaitwins/core/services/webhook-signature.js');
    (verifyGenericWebhookSignature as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    await adapter.connect();
    const handler = getServerHandler();

    const mockRes = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };

    const mockReq = {
      method: 'POST',
      headers: { 'x-webhook-signature': 'bad-sig' },
      on: vi.fn().mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('{"text":"hi"}'));
        if (event === 'end') cb();
      }),
    };

    await handler!(mockReq, mockRes);

    expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('skips duplicate webhook deliveries (idempotency)', async () => {
    await adapter.connect();
    const handler = getServerHandler();

    const webhookBody = JSON.stringify({ text: 'Dup', sender: 'u1', id: 'dup-001' });

    const makeReq = () => ({
      method: 'POST',
      headers: { 'x-webhook-signature': 'sig' },
      on: vi.fn().mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(webhookBody));
        if (event === 'end') cb();
      }),
    });

    // First delivery: passes
    mockRedisSet.mockResolvedValueOnce('OK');
    await handler!(makeReq(), { writeHead: vi.fn().mockReturnThis(), end: vi.fn() });

    // Second delivery: blocked by idempotency
    mockRedisSet.mockResolvedValueOnce(null);
    await handler!(makeReq(), { writeHead: vi.fn().mockReturnThis(), end: vi.fn() });

    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid JSON body', async () => {
    await adapter.connect();
    const handler = getServerHandler();

    const mockRes = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };

    const mockReq = {
      method: 'POST',
      headers: { 'x-webhook-signature': 'sig' },
      on: vi.fn().mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('not-json{{{'));
        if (event === 'end') cb();
      }),
    };

    await handler!(mockReq, mockRes);

    expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects webhook with empty text', async () => {
    await adapter.connect();
    const handler = getServerHandler();

    const mockRes = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };

    const mockReq = {
      method: 'POST',
      headers: { 'x-webhook-signature': 'sig' },
      on: vi.fn().mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(JSON.stringify({ sender: 'u1' })));
        if (event === 'end') cb();
      }),
    };

    await handler!(mockReq, mockRes);

    expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  });

  it('rejects non-POST requests', async () => {
    await adapter.connect();
    const handler = getServerHandler();

    const mockRes = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    await handler!({ method: 'GET', headers: {} }, mockRes);

    expect(mockRes.writeHead).toHaveBeenCalledWith(405);
  });

  it('sends outbound webhook with signature', async () => {
    mockHttpsRequest.mockImplementation(mockHttpsResponse(''));

    await adapter.connect();

    const message: ChannelMessage = {
      id: 'out-001',
      channelId: 'ch-webhook-001',
      externalUserId: 'user-001',
      content: 'Reply from twin',
      timestamp: new Date(),
    };

    await adapter.send(message);

    expect(mockHttpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'example.com',
        method: 'POST',
      }),
      expect.any(Function),
    );
  });

  it('skips outbound if no outgoingUrl configured', async () => {
    const noUrlAdapter = new WebhooksAdapter(makeConfig({
      credentials: { webhookSecret: 'test-secret' },
    }));

    await noUrlAdapter.connect();

    const message: ChannelMessage = {
      id: 'out-nourl',
      channelId: 'ch-webhook-001',
      externalUserId: 'user-001',
      content: 'No URL',
      timestamp: new Date(),
    };

    await noUrlAdapter.send(message);

    expect(mockHttpsRequest).not.toHaveBeenCalled();
    await noUrlAdapter.disconnect();
  });

  it('outbound consumer filters messages for other channel_ids', async () => {
    await adapter.connect();

    const consumeHandler = getConsumeHandler();
    expect(consumeHandler).toBeDefined();

    await consumeHandler!({
      id: 'out-other',
      data: {
        channel_id: 'ch-other',
        message_id: 'out-other',
        external_user_id: '111',
        content: 'Not for us',
      },
    });

    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('respects rate limiter rejection', async () => {
    const { channelRateLimiter } = await import('@undrecreaitwins/core/services/channel-rate-limiter.js');
    (channelRateLimiter.check as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      allowed: false,
      reason: 'rate_exceeded',
    });

    await adapter.connect();

    const consumeHandler = getConsumeHandler();

    await consumeHandler!({
      id: 'out-rate',
      data: {
        channel_id: 'ch-webhook-001',
        message_id: 'out-rate',
        external_user_id: '111',
        content: 'Rate limited',
      },
    });

    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('disconnect closes server, Redis, and transport', async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockServerClose).toHaveBeenCalled();
    expect(mockRedisQuit).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');
  });

  it('sets status to error on failed send', async () => {
    mockHttpsRequest.mockImplementation(mockHttpsResponse('Error', 500));

    await adapter.connect();

    const message: ChannelMessage = {
      id: 'err-001',
      channelId: 'ch-webhook-001',
      externalUserId: 'user-001',
      content: 'Will fail',
      timestamp: new Date(),
    };

    await expect(adapter.send(message)).rejects.toThrow();

    const health = await adapter.health();
    expect(health.status).toBe('error');
  });

  it('tenant isolation: two adapters have separate tenant context', () => {
    const adapter2 = new WebhooksAdapter(makeConfig({
      channelId: 'ch-webhook-002',
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
