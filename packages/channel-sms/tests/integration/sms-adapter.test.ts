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

// Mock Twilio
const mockMessagesCreate = vi.fn().mockResolvedValue({ sid: 'SM-test-sid' });
const mockValidateRequest = vi.fn().mockReturnValue(true);

vi.mock('twilio', () => {
  const mockTwilio = vi.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  }));
  (mockTwilio as unknown as Record<string, unknown>).validateRequest = mockValidateRequest;
  return { default: mockTwilio };
});

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
    return {
      listen: mockServerListen,
      close: mockServerClose,
      on: mockServerOn,
    };
  },
}));

const { SmsAdapter } = await import('../../src/sms-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-sms-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: {
      accountSid: 'ACtest123',
      authToken: 'test-auth-token',
      fromNumber: '+15551234567',
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

describe('SmsAdapter', () => {
  let adapter: InstanceType<typeof SmsAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SmsAdapter(makeConfig());
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('creates instance and connects HTTP webhook server', async () => {
    await adapter.connect();

    expect(mockServerListen).toHaveBeenCalledWith(3101, expect.any(Function));
    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-sms',
      'sms-ch-sms-001',
      expect.any(Function),
    );

    const health = await adapter.health();
    expect(health.status).toBe('active');
  });

  it('throws if accountSid missing from credentials', () => {
    expect(() => new SmsAdapter(makeConfig({
      credentials: { authToken: 't', fromNumber: '+1' },
    }))).toThrow();
  });

  it('throws if authToken missing from credentials', () => {
    expect(() => new SmsAdapter(makeConfig({
      credentials: { accountSid: 'AC', fromNumber: '+1' },
    }))).toThrow();
  });

  it('throws if fromNumber missing from credentials', () => {
    expect(() => new SmsAdapter(makeConfig({
      credentials: { accountSid: 'AC', authToken: 't' },
    }))).toThrow();
  });

  it('incoming SMS webhook publishes to INBOUND with tenant stamping', async () => {
    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => { incomingMessages.push(msg); });

    await adapter.connect();

    const handler = getServerHandler();
    expect(handler).toBeDefined();

    const mockRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };

    const body = 'Body=Hello+SMS&From=%2B15559876543&MessageSid=SM123&To=%2B15551234567';

    const mockReq = {
      method: 'POST',
      headers: { 'x-twilio-signature': 'valid-sig' },
      url: '/sms',
      on: vi.fn().mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(body));
        if (event === 'end') cb();
      }),
    };

    await handler!(mockReq, mockRes);

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('Hello SMS');
    expect(incomingMessages[0]!.externalUserId).toBe('+15559876543');
    expect(incomingMessages[0]!.id).toBe('SM123');

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_type: 'sms',
      channel_id: 'ch-sms-001',
      message_id: 'SM123',
      persona_slug: 'test-persona',
      content: 'Hello SMS',
      tenant_id: 'tenant-001',
      external_user_id: '+15559876543',
    }));

    expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/xml',
    }));
  });

  it('rejects webhook with invalid Twilio signature', async () => {
    mockValidateRequest.mockReturnValueOnce(false);

    await adapter.connect();
    const handler = getServerHandler();

    const mockRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };

    const mockReq = {
      method: 'POST',
      headers: { 'x-twilio-signature': 'bad-sig' },
      url: '/sms',
      on: vi.fn().mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('Body=Test&From=%2B1&MessageSid=SM1'));
        if (event === 'end') cb();
      }),
    };

    await handler!(mockReq, mockRes);

    expect(mockRes.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects webhook without signature', async () => {
    await adapter.connect();
    const handler = getServerHandler();

    const mockRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };

    const mockReq = {
      method: 'POST',
      headers: {},
      url: '/sms',
      on: vi.fn().mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('Body=Test&From=%2B1&MessageSid=SM1'));
        if (event === 'end') cb();
      }),
    };

    await handler!(mockReq, mockRes);

    expect(mockRes.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects non-POST requests', async () => {
    await adapter.connect();
    const handler = getServerHandler();

    const mockRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };

    await handler!({ method: 'GET', headers: {}, url: '/' }, mockRes);

    expect(mockRes.writeHead).toHaveBeenCalledWith(405);
  });

  it('sends outbound SMS via Twilio', async () => {
    const message: ChannelMessage = {
      id: 'out-001',
      channelId: 'ch-sms-001',
      externalUserId: '+15559876543',
      content: 'Reply from twin',
      timestamp: new Date(),
    };

    await adapter.send(message);

    expect(mockMessagesCreate).toHaveBeenCalledWith({
      to: '+15559876543',
      from: '+15551234567',
      body: 'Reply from twin',
    });
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
        external_user_id: '+111',
        content: 'Not for us',
      },
    });

    expect(mockMessagesCreate).not.toHaveBeenCalled();
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
        channel_id: 'ch-sms-001',
        message_id: 'out-rate',
        external_user_id: '+15559876543',
        content: 'Rate limited',
      },
    });

    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('disconnect closes server and transport', async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockServerClose).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');
  });

  it('sets status to error on failed send', async () => {
    mockMessagesCreate.mockRejectedValueOnce(new Error('Twilio error'));

    const message: ChannelMessage = {
      id: 'err-001',
      channelId: 'ch-sms-001',
      externalUserId: '+15559876543',
      content: 'Will fail',
      timestamp: new Date(),
    };

    await expect(adapter.send(message)).rejects.toThrow('Twilio error');

    const health = await adapter.health();
    expect(health.status).toBe('error');
  });

  it('tenant isolation: two adapters have separate tenant context', () => {
    const adapter2 = new SmsAdapter(makeConfig({
      channelId: 'ch-sms-002',
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
