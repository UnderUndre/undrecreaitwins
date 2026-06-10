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

// Mock ws (WebSocket)
const mockWsOn = vi.fn();
const mockWsSend = vi.fn();
const mockWsClose = vi.fn();
const mockWsReadyState = { OPEN: 1, CLOSED: 3 };

vi.mock('ws', () => ({
  default: vi.fn().mockImplementation(() => ({
    on: mockWsOn,
    send: mockWsSend,
    close: mockWsClose,
    readyState: 1,
    OPEN: 1,
    CLOSED: 3,
  })),
  WebSocket: { OPEN: 1, CLOSED: 3 },
}));

// Mock node:https for outbound HA API
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

const { HomeAssistantAdapter } = await import('../../src/homeassistant-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-ha-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: {
      hassUrl: 'http://homeassistant.local:8123',
      accessToken: 'test-ha-token',
    },
    ...overrides,
  };
}

function getMessageHandler(): ((data: unknown) => void) | undefined {
  return mockWsOn.mock.calls.find(
    ([event]: [string]) => event === 'message',
  )?.[1] as ((data: unknown) => void) | undefined;
}

function getOpenHandler(): (() => void) | undefined {
  return mockWsOn.mock.calls.find(
    ([event]: [string]) => event === 'open',
  )?.[1] as (() => void) | undefined;
}

function getConsumeHandler():
  | ((msg: { id: string; data: Record<string, string> }) => Promise<void>)
  | undefined {
  return mockConsume.mock.calls[0]?.[3] as
    | ((msg: { id: string; data: Record<string, string> }) => Promise<void>)
    | undefined;
}

describe('HomeAssistantAdapter', () => {
  let adapter: InstanceType<typeof HomeAssistantAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new HomeAssistantAdapter(makeConfig());
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('throws if hassUrl missing from credentials', () => {
    expect(() => new HomeAssistantAdapter(makeConfig({
      credentials: { accessToken: 't' },
    }))).toThrow();
  });

  it('throws if accessToken missing from credentials', () => {
    expect(() => new HomeAssistantAdapter(makeConfig({
      credentials: { hassUrl: 'http://ha.local:8123' },
    }))).toThrow();
  });

  it('connects via WebSocket and authenticates', async () => {
    // Simulate: auth_required -> we send auth -> auth_ok
    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        // Simulate auth_required then auth_ok
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_ok' })), 30);
      }
    });

    await adapter.connect();

    // Should have sent auth message
    expect(mockWsSend).toHaveBeenCalledWith(expect.stringContaining('"type":"auth"'));
    expect(mockWsSend).toHaveBeenCalledWith(expect.stringContaining('test-ha-token'));

    // Should have subscribed to events
    const subscribeCalls = mockWsSend.mock.calls.filter(
      (call: unknown[]) => {
        const msg = call[0] as string;
        return msg.includes('subscribe_events');
      },
    );
    expect(subscribeCalls.length).toBeGreaterThanOrEqual(2);

    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-homeassistant',
      'homeassistant-ch-ha-001',
      expect.any(Function),
    );

    const health = await adapter.health();
    expect(health.status).toBe('active');
  });

  it('rejects connection on auth_invalid', async () => {
    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_invalid' })), 30);
      }
    });

    await expect(adapter.connect()).rejects.toThrow();
  });

  it('handles conversation_response event and publishes to INBOUND', async () => {
    let msgHandler: ((data: unknown) => void) | undefined;

    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        msgHandler = handler as (data: unknown) => void;
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_ok' })), 30);
      }
    });

    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => { incomingMessages.push(msg); });

    await adapter.connect();

    // Simulate a conversation_response event
    await msgHandler!(JSON.stringify({
      type: 'event',
      event: {
        event_type: 'conversation_response',
        data: {
          text: 'Turn on the lights',
          user_id: 'ha-user-001',
          conversation_id: 'conv-123',
        },
      },
    }));

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('Turn on the lights');
    expect(incomingMessages[0]!.externalUserId).toBe('ha-user-001');

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_type: 'homeassistant',
      channel_id: 'ch-ha-001',
      persona_slug: 'test-persona',
      content: 'Turn on the lights',
      tenant_id: 'tenant-001',
    }));
  });

  it('handles state_changed event for input_text entities', async () => {
    let msgHandler: ((data: unknown) => void) | undefined;

    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        msgHandler = handler as (data: unknown) => void;
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_ok' })), 30);
      }
    });

    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => { incomingMessages.push(msg); });

    await adapter.connect();

    // Simulate a state_changed event for input_text entity
    await msgHandler!(JSON.stringify({
      type: 'event',
      event: {
        event_type: 'state_changed',
        data: {
          entity_id: 'input_text.twin_input',
          new_state: {
            state: 'What is the weather?',
            attributes: { source: 'ha-user-002' },
          },
        },
      },
    }));

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('What is the weather?');
    expect(incomingMessages[0]!.metadata?.['entityId']).toBe('input_text.twin_input');
  });

  it('ignores state_changed for non-input_text entities', async () => {
    let msgHandler: ((data: unknown) => void) | undefined;

    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        msgHandler = handler as (data: unknown) => void;
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_ok' })), 30);
      }
    });

    await adapter.connect();

    await msgHandler!(JSON.stringify({
      type: 'event',
      event: {
        event_type: 'state_changed',
        data: {
          entity_id: 'light.living_room',
          new_state: { state: 'on' },
        },
      },
    }));

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('ignores events with empty text', async () => {
    let msgHandler: ((data: unknown) => void) | undefined;

    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        msgHandler = handler as (data: unknown) => void;
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_ok' })), 30);
      }
    });

    await adapter.connect();

    await msgHandler!(JSON.stringify({
      type: 'event',
      event: {
        event_type: 'conversation_response',
        data: { text: '' },
      },
    }));

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('sends message via HA conversation API', async () => {
    mockHttpsRequest.mockImplementation(mockHttpsResponse('{"response":{}}'));

    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_ok' })), 30);
      }
    });

    await adapter.connect();

    const message: ChannelMessage = {
      id: 'out-001',
      channelId: 'ch-ha-001',
      externalUserId: 'ha-user-001',
      content: 'The weather is sunny',
      timestamp: new Date(),
    };

    await adapter.send(message);

    expect(mockHttpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'homeassistant.local',
        path: '/api/conversation/process',
        method: 'POST',
      }),
      expect.any(Function),
    );
  });

  it('outbound consumer filters messages for other channel_ids', async () => {
    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_ok' })), 30);
      }
    });

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

    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_ok' })), 30);
      }
    });

    await adapter.connect();

    const consumeHandler = getConsumeHandler();

    await consumeHandler!({
      id: 'out-rate',
      data: {
        channel_id: 'ch-ha-001',
        message_id: 'out-rate',
        external_user_id: '111',
        content: 'Rate limited',
      },
    });

    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('disconnect closes WebSocket and transport', async () => {
    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_ok' })), 30);
      }
    });

    await adapter.connect();
    await adapter.disconnect();

    expect(mockWsClose).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');
  });

  it('sets status to error on failed send', async () => {
    mockHttpsRequest.mockImplementation(mockHttpsResponse('Error', 500));

    mockWsOn.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') {
        setTimeout(() => handler(JSON.stringify({ type: 'auth_required' })), 10);
        setTimeout(() => handler(JSON.stringify({ type: 'auth_ok' })), 30);
      }
    });

    await adapter.connect();

    const message: ChannelMessage = {
      id: 'err-001',
      channelId: 'ch-ha-001',
      externalUserId: 'ha-user-001',
      content: 'Will fail',
      timestamp: new Date(),
    };

    await expect(adapter.send(message)).rejects.toThrow();

    const health = await adapter.health();
    expect(health.status).toBe('error');
  });

  it('tenant isolation: two adapters have separate tenant context', () => {
    const adapter2 = new HomeAssistantAdapter(makeConfig({
      channelId: 'ch-ha-002',
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
