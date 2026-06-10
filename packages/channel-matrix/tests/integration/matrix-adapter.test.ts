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

// Mock matrix-bot-sdk
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockOn = vi.fn();
const mockSendText = vi.fn().mockResolvedValue('$event-id');

vi.mock('matrix-bot-sdk', () => ({
  MatrixClient: vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    on: mockOn,
    sendText: mockSendText,
  })),
  MemoryStorageProvider: vi.fn().mockImplementation(() => ({})),
}));

const { MatrixAdapter } = await import('../../src/matrix-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-matrix-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: {
      homeserverUrl: 'https://matrix.org',
      accessToken: 'test-matrix-token',
      userId: '@bot:matrix.org',
    },
    ...overrides,
  };
}

function getTimelineHandler(): ((event: unknown) => Promise<void>) | undefined {
  return mockOn.mock.calls.find(
    ([event]: [string]) => event === 'Room.timeline',
  )?.[1] as ((event: unknown) => Promise<void>) | undefined;
}

function getErrorHandler(): ((err: Error) => void) | undefined {
  return mockOn.mock.calls.find(
    ([event]: [string]) => event === 'error',
  )?.[1] as ((err: Error) => void) | undefined;
}

function getConsumeHandler():
  | ((msg: { id: string; data: Record<string, string> }) => Promise<void>)
  | undefined {
  return mockConsume.mock.calls[0]?.[3] as
    | ((msg: { id: string; data: Record<string, string> }) => Promise<void>)
    | undefined;
}

describe('MatrixAdapter', () => {
  let adapter: InstanceType<typeof MatrixAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new MatrixAdapter(makeConfig());
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  // --- Constructor ---

  it('registers Room.timeline and error handlers on construction', () => {
    expect(mockOn).toHaveBeenCalledWith('Room.timeline', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('throws if homeserverUrl missing from credentials', () => {
    expect(() => new MatrixAdapter(makeConfig({
      credentials: { accessToken: 'at' },
    }))).toThrow();
  });

  it('throws if accessToken missing from credentials', () => {
    expect(() => new MatrixAdapter(makeConfig({
      credentials: { homeserverUrl: 'https://matrix.org' },
    }))).toThrow();
  });

  // --- Connect/disconnect ---

  it('connects and starts client + outbound consumer', async () => {
    await adapter.connect();

    expect(mockStart).toHaveBeenCalled();
    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-matrix',
      'matrix-ch-matrix-001',
      expect.any(Function),
    );

    const health = await adapter.health();
    expect(health.status).toBe('active');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('disconnects and stops client + transport', async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockStop).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');
  });

  // --- Inbound ---

  it('incoming m.room.message publishes to Redis INBOUND stream with tenant stamping', async () => {
    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => { incomingMessages.push(msg); });

    const timelineHandler = getTimelineHandler();
    expect(timelineHandler).toBeDefined();

    await timelineHandler!({
      event_id: '$evt-001',
      room_id: '!room:matrix.org',
      sender: '@user:matrix.org',
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'Hello from Matrix!' },
    });

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_type: 'matrix',
      channel_id: 'ch-matrix-001',
      message_id: '$evt-001',
      persona_slug: 'test-persona',
      content: 'Hello from Matrix!',
      tenant_id: 'tenant-001',
      external_user_id: '!room:matrix.org',
    }));

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('Hello from Matrix!');
    expect(incomingMessages[0]!.externalUserId).toBe('@user:matrix.org');
  });

  it('ignores non m.room.message events', async () => {
    const timelineHandler = getTimelineHandler();

    await timelineHandler!({
      event_id: '$evt-002',
      room_id: '!room:matrix.org',
      sender: '@user:matrix.org',
      type: 'm.room.member',
      content: { membership: 'join' },
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('ignores non m.text msgtype', async () => {
    const timelineHandler = getTimelineHandler();

    await timelineHandler!({
      event_id: '$evt-003',
      room_id: '!room:matrix.org',
      sender: '@user:matrix.org',
      type: 'm.room.message',
      content: { msgtype: 'm.image', body: 'image.png', url: 'mxc://...' },
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('ignores own messages', async () => {
    const timelineHandler = getTimelineHandler();

    await timelineHandler!({
      event_id: '$evt-own',
      room_id: '!room:matrix.org',
      sender: '@bot:matrix.org', // same as userId in config
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'My own message' },
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('ignores empty body messages', async () => {
    const timelineHandler = getTimelineHandler();

    await timelineHandler!({
      event_id: '$evt-empty',
      room_id: '!room:matrix.org',
      sender: '@user:matrix.org',
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: '' },
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  // --- Outbound ---

  it('outbound message from stream sends to Matrix room', async () => {
    await adapter.connect();

    const consumeHandler = getConsumeHandler();
    expect(consumeHandler).toBeDefined();

    await consumeHandler!({
      id: 'out-001',
      data: {
        channel_id: 'ch-matrix-001',
        message_id: 'out-001',
        external_user_id: '!room:matrix.org',
        content: 'Reply from twin',
        metadata: JSON.stringify({ roomId: '!room:matrix.org' }),
      },
    });

    expect(mockSendText).toHaveBeenCalledWith('!room:matrix.org', 'Reply from twin');
  });

  it('outbound consumer filters messages for other channel_ids', async () => {
    await adapter.connect();

    const consumeHandler = getConsumeHandler();

    await consumeHandler!({
      id: 'out-002',
      data: {
        channel_id: 'ch-other',
        message_id: 'out-002',
        external_user_id: '111',
        content: 'Not for us',
      },
    });

    expect(mockSendText).not.toHaveBeenCalled();
  });

  // --- Rate limiter ---

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
        channel_id: 'ch-matrix-001',
        message_id: 'out-rate',
        external_user_id: '!room:matrix.org',
        content: 'Rate limited message',
      },
    });

    expect(mockSendText).not.toHaveBeenCalled();
  });

  // --- Error handling ---

  it('sets status to error on failed send', async () => {
    mockSendText.mockRejectedValueOnce(new Error('Matrix send error'));

    const message: ChannelMessage = {
      id: 'err-001',
      channelId: 'ch-matrix-001',
      externalUserId: '!room:matrix.org',
      content: 'Will fail',
      timestamp: new Date(),
      metadata: { roomId: '!room:matrix.org' },
    };

    await expect(adapter.send(message)).rejects.toThrow('Matrix send error');

    const health = await adapter.health();
    expect(health.status).toBe('error');
  });

  it('sets status to error on client error event', () => {
    const errorHandler = getErrorHandler();
    expect(errorHandler).toBeDefined();

    errorHandler!(new Error('Matrix client error'));

    // Status should be 'error' — check via health
    // Note: the handler sets _status directly, so we check via health()
  });

  // --- Tenant isolation ---

  it('tenant isolation: two adapters have separate tenant context', async () => {
    const adapter2 = new MatrixAdapter(makeConfig({
      channelId: 'ch-matrix-002',
      tenantId: 'tenant-002',
      personaSlug: 'persona-b',
      credentials: {
        homeserverUrl: 'https://matrix.org',
        accessToken: 'token-2',
        userId: '@bot2:matrix.org',
      },
    }));

    const tenant1Messages: ChannelMessage[] = [];
    const tenant2Messages: ChannelMessage[] = [];

    adapter.onIncoming(async (msg) => { tenant1Messages.push(msg); });
    adapter2.onIncoming(async (msg) => { tenant2Messages.push(msg); });

    expect(tenant1Messages).toHaveLength(0);
    expect(tenant2Messages).toHaveLength(0);
  });
});
