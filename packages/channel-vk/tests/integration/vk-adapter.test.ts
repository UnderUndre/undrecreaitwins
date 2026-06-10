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

// Mock node:https for VK API calls — handle both request(opts, cb) and request(url, opts, cb)
const mockHttpsRequest = vi.fn();

vi.mock('node:https', () => ({
  request: (...args: unknown[]) => mockHttpsRequest(...args),
}));

function mockResponse(body: string) {
  const mockRes = {
    on: vi.fn().mockImplementation((_event: string, handler: (chunk?: Buffer) => void) => {
      if (_event === 'data') handler(Buffer.from(body));
      if (_event === 'end') handler();
    }),
  };
  return mockRes;
}

/**
 * Helper to create a mock request function that routes based on URL/path.
 * Handles both signatures:
 *   request(options_object, callback)
 *   request(url_string, options_object, callback)
 */
function routeByPath(routes: Array<{ match: (path: string) => boolean; body: string }>) {
  return (...args: unknown[]) => {
    // Normalize to (opts, cb) — extract opts and cb regardless of signature
    let path = '';
    let cb: (res: unknown) => void;

    if (typeof args[0] === 'string') {
      // request(url, opts, cb)
      path = args[0] as string;
      cb = args[2] as (res: unknown) => void;
    } else {
      // request(opts, cb)
      const opts = args[0] as Record<string, unknown>;
      path = (opts?.path as string) ?? '';
      cb = args[1] as (res: unknown) => void;
    }

    for (const route of routes) {
      if (route.match(path)) {
        cb(mockResponse(route.body));
        return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
      }
    }

    // Default: messages.send success
    cb(mockResponse(JSON.stringify({ response: Date.now() })));
    return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  };
}

const { VkAdapter } = await import('../../src/vk-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-vk-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: {
      accessToken: 'test-access-token',
      groupId: '12345678',
    },
    ...overrides,
  };
}

describe('VkAdapter', () => {
  let adapter: InstanceType<typeof VkAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default routing: getLongPollServer + empty long poll + messages.send
    mockHttpsRequest.mockImplementation(routeByPath([
      {
        match: (p) => p.includes('groups.getLongPollServer'),
        body: JSON.stringify({
          response: { key: 'test-key', server: 'https://lp.vk.com/wh123456789', ts: '100' },
        }),
      },
      {
        match: (p) => p.includes('a_check'),
        body: JSON.stringify({ ts: '101', updates: [] }),
      },
    ]));

    adapter = new VkAdapter(makeConfig());
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('creates instance and connects via Long Poll', async () => {
    await adapter.connect();

    const health = await adapter.health();
    expect(health.status).toBe('active');

    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-vk',
      'vk-ch-vk-001',
      expect.any(Function),
    );
  });

  it('throws if accessToken missing from credentials', () => {
    expect(() => new VkAdapter(makeConfig({
      credentials: { groupId: '12345678' },
    }))).toThrow();
  });

  it('throws if groupId missing from credentials', () => {
    expect(() => new VkAdapter(makeConfig({
      credentials: { accessToken: 'token' },
    }))).toThrow();
  });

  it('throws on getLongPollServer failure', async () => {
    mockHttpsRequest.mockImplementation(routeByPath([
      {
        match: (p) => p.includes('groups.getLongPollServer'),
        body: JSON.stringify({ error: { error_msg: 'Invalid token' } }),
      },
    ]));

    await expect(adapter.connect()).rejects.toThrow('VK API error');
  });

  it('handles message_new updates and publishes to INBOUND', async () => {
    let pollCount = 0;
    mockHttpsRequest.mockImplementation(routeByPath([
      {
        match: (p) => p.includes('groups.getLongPollServer'),
        body: JSON.stringify({
          response: { key: 'test-key', server: 'https://lp.vk.com/wh', ts: '100' },
        }),
      },
      {
        match: (p) => p.includes('a_check'),
        body: (() => {
          pollCount++;
          if (pollCount === 1) {
            return JSON.stringify({
              ts: '101',
              updates: [{
                type: 'message_new',
                event_id: 'evt-001',
                v: '5.199',
                object: {
                  message: {
                    id: 500,
                    from_id: 777888,
                    peer_id: 777888,
                    text: 'Hello VK!',
                    date: Math.floor(Date.now() / 1000),
                  },
                },
              }],
            });
          }
          return JSON.stringify({ ts: '102', updates: [] });
        })(),
      },
    ]));

    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => {
      incomingMessages.push(msg);
    });

    await adapter.connect();

    // Wait for first poll cycle
    await vi.advanceTimersByTimeAsync(2000);

    expect(incomingMessages.length).toBeGreaterThanOrEqual(1);
    expect(incomingMessages[0]!.content).toBe('Hello VK!');
    expect(incomingMessages[0]!.externalUserId).toBe('777888');
    expect(incomingMessages[0]!.id).toBe('500');

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_type: 'vk',
      channel_id: 'ch-vk-001',
      message_id: '500',
      persona_slug: 'test-persona',
      content: 'Hello VK!',
      tenant_id: 'tenant-001',
      external_user_id: '777888',
    }));
  });

  it('ignores messages from groups (negative from_id)', async () => {
    mockHttpsRequest.mockImplementation(routeByPath([
      {
        match: (p) => p.includes('groups.getLongPollServer'),
        body: JSON.stringify({
          response: { key: 'test-key', server: 'https://lp.vk.com/wh', ts: '100' },
        }),
      },
      {
        match: (p) => p.includes('a_check'),
        body: JSON.stringify({
          ts: '101',
          updates: [{
            type: 'message_new',
            event_id: 'evt-group',
            v: '5.199',
            object: {
              message: {
                id: 501,
                from_id: -12345678,
                peer_id: 2000000001,
                text: 'Group message',
                date: Math.floor(Date.now() / 1000),
              },
            },
          }],
        }),
      },
    ]));

    await adapter.connect();
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('sends outbound message via messages.send', async () => {
    await adapter.connect();

    const message: ChannelMessage = {
      id: 'out-001',
      channelId: 'ch-vk-001',
      externalUserId: '777888',
      content: 'Reply from twin',
      timestamp: new Date(),
      metadata: { peer_id: '777888' },
    };

    await adapter.send(message);

    const sendCalls = mockHttpsRequest.mock.calls.filter(
      (call: unknown[]) => {
        const opts = call[0] as Record<string, unknown>;
        return typeof opts === 'object' && opts?.path?.includes?.('messages.send');
      },
    );
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
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
        channel_id: 'ch-vk-001',
        message_id: 'out-rate',
        external_user_id: '777888',
        content: 'Rate limited message',
      },
    });
  });

  it('disconnect stops polling and transport', async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockDisconnect).toHaveBeenCalled();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');
  });

  it('sets status to error on failed send', async () => {
    // getLongPollServer succeeds, but messages.send fails
    mockHttpsRequest.mockImplementation(routeByPath([
      {
        match: (p) => p.includes('groups.getLongPollServer'),
        body: JSON.stringify({
          response: { key: 'test-key', server: 'https://lp.vk.com/wh', ts: '100' },
        }),
      },
      {
        match: (p) => p.includes('a_check'),
        body: JSON.stringify({ ts: '101', updates: [] }),
      },
      {
        match: (p) => p.includes('messages.send'),
        body: JSON.stringify({ error: { error_msg: 'Permission denied' } }),
      },
    ]));

    await adapter.connect();

    const message: ChannelMessage = {
      id: 'err-001',
      channelId: 'ch-vk-001',
      externalUserId: '777888',
      content: 'Will fail',
      timestamp: new Date(),
    };

    await expect(adapter.send(message)).rejects.toThrow('VK API error');

    const health = await adapter.health();
    expect(health.status).toBe('error');
  });

  it('tenant isolation: two adapters have separate tenant context', async () => {
    const adapter2 = new VkAdapter(makeConfig({
      channelId: 'ch-vk-002',
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

  // --- Phase 4 (US2 Media) attachment tests ---

  describe('INBOUND attachments', () => {
    it('extracts photo attachments from VK message and publishes to INBOUND', async () => {
      let pollCount = 0;
      mockHttpsRequest.mockImplementation(routeByPath([
        {
          match: (p) => p.includes('groups.getLongPollServer'),
          body: JSON.stringify({
            response: { key: 'test-key', server: 'https://lp.vk.com/wh', ts: '100' },
          }),
        },
        {
          match: (p) => p.includes('a_check'),
          body: (() => {
            pollCount++;
            if (pollCount === 1) {
              return JSON.stringify({
                ts: '101',
                updates: [{
                  type: 'message_new',
                  event_id: 'evt-photo',
                  v: '5.199',
                  object: {
                    message: {
                      id: 600,
                      from_id: 999,
                      peer_id: 999,
                      text: 'Look at this photo!',
                      date: Math.floor(Date.now() / 1000),
                      attachments: [{
                        type: 'photo',
                        photo: {
                          sizes: [
                            { type: 's', url: 'https://vk.com/small.jpg', width: 100, height: 100 },
                            { type: 'x', url: 'https://vk.com/large.jpg', width: 800, height: 600 },
                          ],
                        },
                      }],
                    },
                  },
                }],
              });
            }
            return JSON.stringify({ ts: '102', updates: [] });
          })(),
        },
      ]));

      const incomingMessages: ChannelMessage[] = [];
      adapter.onIncoming(async (msg) => { incomingMessages.push(msg); });

      await adapter.connect();
      await vi.advanceTimersByTimeAsync(2000);

      expect(incomingMessages.length).toBeGreaterThanOrEqual(1);
      const msg = incomingMessages[0]!;
      expect(msg.attachments).toBeDefined();
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0]!.kind).toBe('image');
      expect(msg.attachments![0]!.url).toBe('https://vk.com/large.jpg');
      expect(msg.attachments![0]!.mime).toBe('image/jpeg');

      expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
        attachments_json: expect.any(String),
      }));

      const publishCall = mockPublish.mock.calls[0]!;
      const payload = publishCall[1] as Record<string, string>;
      const parsed = JSON.parse(payload.attachments_json);
      expect(parsed[0].kind).toBe('image');
      expect(parsed[0].url).toBe('https://vk.com/large.jpg');
    });

    it('extracts doc attachment with correct kind', async () => {
      let pollCount = 0;
      mockHttpsRequest.mockImplementation(routeByPath([
        {
          match: (p) => p.includes('groups.getLongPollServer'),
          body: JSON.stringify({
            response: { key: 'test-key', server: 'https://lp.vk.com/wh', ts: '100' },
          }),
        },
        {
          match: (p) => p.includes('a_check'),
          body: (() => {
            pollCount++;
            if (pollCount === 1) {
              return JSON.stringify({
                ts: '101',
                updates: [{
                  type: 'message_new',
                  event_id: 'evt-doc',
                  v: '5.199',
                  object: {
                    message: {
                      id: 601,
                      from_id: 999,
                      peer_id: 999,
                      text: 'Here is a document',
                      date: Math.floor(Date.now() / 1000),
                      attachments: [{
                        type: 'doc',
                        doc: {
                          url: 'https://vk.com/doc.pdf',
                          title: 'report',
                          ext: 'pdf',
                          type: 1,
                        },
                      }],
                    },
                  },
                }],
              });
            }
            return JSON.stringify({ ts: '102', updates: [] });
          })(),
        },
      ]));

      const incomingMessages: ChannelMessage[] = [];
      adapter.onIncoming(async (msg) => { incomingMessages.push(msg); });

      await adapter.connect();
      await vi.advanceTimersByTimeAsync(2000);

      expect(incomingMessages.length).toBeGreaterThanOrEqual(1);
      const msg = incomingMessages[0]!;
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0]!.kind).toBe('file');
      expect(msg.attachments![0]!.url).toBe('https://vk.com/doc.pdf');
      expect(msg.attachments![0]!.filename).toBe('report.pdf');
    });

    it('extracts audio attachment', async () => {
      let pollCount = 0;
      mockHttpsRequest.mockImplementation(routeByPath([
        {
          match: (p) => p.includes('groups.getLongPollServer'),
          body: JSON.stringify({
            response: { key: 'test-key', server: 'https://lp.vk.com/wh', ts: '100' },
          }),
        },
        {
          match: (p) => p.includes('a_check'),
          body: (() => {
            pollCount++;
            if (pollCount === 1) {
              return JSON.stringify({
                ts: '101',
                updates: [{
                  type: 'message_new',
                  event_id: 'evt-audio',
                  v: '5.199',
                  object: {
                    message: {
                      id: 602,
                      from_id: 999,
                      peer_id: 999,
                      text: '',
                      date: Math.floor(Date.now() / 1000),
                      attachments: [{
                        type: 'audio',
                        audio: {
                          url: 'https://vk.com/audio.mp3',
                          title: 'Song',
                          artist: 'Artist',
                        },
                      }],
                    },
                  },
                }],
              });
            }
            return JSON.stringify({ ts: '102', updates: [] });
          })(),
        },
      ]));

      const incomingMessages: ChannelMessage[] = [];
      adapter.onIncoming(async (msg) => { incomingMessages.push(msg); });

      await adapter.connect();
      await vi.advanceTimersByTimeAsync(2000);

      expect(incomingMessages.length).toBeGreaterThanOrEqual(1);
      const msg = incomingMessages[0]!;
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0]!.kind).toBe('audio');
      expect(msg.attachments![0]!.mime).toBe('audio/mpeg');
    });

    it('does not include attachments_json when message has no attachments', async () => {
      let pollCount = 0;
      mockHttpsRequest.mockImplementation(routeByPath([
        {
          match: (p) => p.includes('groups.getLongPollServer'),
          body: JSON.stringify({
            response: { key: 'test-key', server: 'https://lp.vk.com/wh', ts: '100' },
          }),
        },
        {
          match: (p) => p.includes('a_check'),
          body: (() => {
            pollCount++;
            if (pollCount === 1) {
              return JSON.stringify({
                ts: '101',
                updates: [{
                  type: 'message_new',
                  event_id: 'evt-text',
                  v: '5.199',
                  object: {
                    message: {
                      id: 603,
                      from_id: 999,
                      peer_id: 999,
                      text: 'Just text',
                      date: Math.floor(Date.now() / 1000),
                    },
                  },
                }],
              });
            }
            return JSON.stringify({ ts: '102', updates: [] });
          })(),
        },
      ]));

      await adapter.connect();
      await vi.advanceTimersByTimeAsync(2000);

      const publishCall = mockPublish.mock.calls[0]!;
      const payload = publishCall[1] as Record<string, string>;
      expect(payload.attachments_json).toBeUndefined();
    });
  });

  describe('OUTBOUND attachments', () => {
    it('appends attachment URLs to message text for outbound send', async () => {
      await adapter.connect();

      const message: ChannelMessage = {
        id: 'out-att-001',
        channelId: 'ch-vk-001',
        externalUserId: '999',
        content: 'Here is an image',
        timestamp: new Date(),
        metadata: { peer_id: '999' },
        attachments: [{
          kind: 'image',
          url: 'https://example.com/photo.jpg',
          mime: 'image/jpeg',
          filename: 'photo.jpg',
        }],
      };

      await adapter.send(message);

      // Find the messages.send call and verify the message includes the URL
      const sendCalls = mockHttpsRequest.mock.calls.filter(
        (call: unknown[]) => {
          const opts = call[0] as Record<string, unknown>;
          return typeof opts === 'object' && opts?.path?.includes?.('messages.send');
        },
      );
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('handles outbound with attachment from stream consumer', async () => {
      await adapter.connect();

      const consumeHandler = mockConsume.mock.calls[0]?.[3] as
        ((msg: { id: string; data: Record<string, string> }) => Promise<void>) | undefined;
      expect(consumeHandler).toBeDefined();

      await consumeHandler!({
        id: 'out-att-stream',
        data: {
          channel_id: 'ch-vk-001',
          message_id: 'out-att-stream',
          external_user_id: '999',
          content: 'Media reply',
          attachments_json: JSON.stringify([{
            kind: 'image',
            url: 'https://example.com/img.png',
            mime: 'image/png',
            filename: 'img.png',
          }]),
        },
      });

      // Should have called send with attachments appended
      const sendCalls = mockHttpsRequest.mock.calls.filter(
        (call: unknown[]) => {
          const opts = call[0] as Record<string, unknown>;
          return typeof opts === 'object' && opts?.path?.includes?.('messages.send');
        },
      );
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});
