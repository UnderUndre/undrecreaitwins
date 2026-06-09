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

// Mock WebSocket globally
const mockWsSend = vi.fn();
const mockWsClose = vi.fn();
const mockWsAddEventListener = vi.fn().mockImplementation((_event: string, handler: (e: unknown) => void) => {
  if (_event === 'open') {
    handler({});
  }
});

vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => ({
  addEventListener: mockWsAddEventListener,
  send: mockWsSend,
  close: mockWsClose,
})));

const { MattermostAdapter } = await import('../../src/mattermost-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-mm-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: { botToken: 'test-mm-token', serverUrl: 'https://mattermost.example.com' },
    ...overrides,
  };
}

describe('MattermostAdapter', () => {
  let adapter: InstanceType<typeof MattermostAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new MattermostAdapter(makeConfig());
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('creates instance and connects WebSocket', async () => {
    await adapter.connect();

    expect(WebSocket).toHaveBeenCalledWith('wss://mattermost.example.com/api/v4/websocket');
    expect(mockWsAddEventListener).toHaveBeenCalledWith('open', expect.any(Function));
    expect(mockWsSend).toHaveBeenCalledWith(expect.stringContaining('authentication_challenge'));
    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-mattermost',
      'mattermost-ch-mm-001',
      expect.any(Function),
    );

    const health = await adapter.health();
    expect(health.status).toBe('active');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('throws if botToken missing from credentials', () => {
    expect(() => new MattermostAdapter(makeConfig({ credentials: { serverUrl: 'https://example.com' } }))).toThrow();
  });

  it('throws if serverUrl missing from credentials', () => {
    expect(() => new MattermostAdapter(makeConfig({ credentials: { botToken: 'token' } }))).toThrow();
  });

  it('handles incoming posted event and publishes to INBOUND', async () => {
    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => {
      incomingMessages.push(msg);
    });

    await adapter.connect();

    // Find the message handler
    const msgHandler = mockWsAddEventListener.mock.calls.find(
      ([event]: [string]) => event === 'message',
    )?.[1] as ((e: unknown) => void) | undefined;
    expect(msgHandler).toBeDefined();

    const postedEvent = {
      data: JSON.stringify({
        event: 'posted',
        data: {
          post: JSON.stringify({
            id: 'post-001',
            user_id: 'user-123',
            message: 'Hello Mattermost twin!',
            channel_id: 'chan-456',
            create_at: Date.now(),
          }),
        },
      }),
    };

    await msgHandler!({ data: postedEvent.data });

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_type: 'mattermost',
      channel_id: 'ch-mm-001',
      content: 'Hello Mattermost twin!',
      tenant_id: 'tenant-001',
      external_user_id: 'user-123',
    }));

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('Hello Mattermost twin!');
  });

  it('ignores bot messages in posted events', async () => {
    await adapter.connect();

    const msgHandler = mockWsAddEventListener.mock.calls.find(
      ([event]: [string]) => event === 'message',
    )?.[1] as ((e: unknown) => void) | undefined;

    const botEvent = {
      data: JSON.stringify({
        event: 'posted',
        data: {
          post: JSON.stringify({
            id: 'post-bot',
            user_id: 'bot-user',
            message: 'Bot message',
            channel_id: 'chan-456',
            create_at: Date.now(),
            props: { from_bot: 'true' },
          }),
        },
      }),
    };

    await msgHandler!({ data: botEvent.data });
    expect(mockPublish).not.toHaveBeenCalled();
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

  it('disconnects WebSocket and transport', async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockWsClose).toHaveBeenCalled();
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
        channel_id: 'ch-mm-001',
        message_id: 'out-rate',
        external_user_id: '111',
        content: 'Rate limited message',
      },
    });
  });

  it('tenant isolation: two adapters have separate tenant context', async () => {
    const adapter2 = new MattermostAdapter(makeConfig({
      channelId: 'ch-mm-002',
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
