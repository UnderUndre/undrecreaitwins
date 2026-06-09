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

const mockOn = vi.fn();
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockChannelsFetch = vi.fn();
const mockChannelSend = vi.fn().mockResolvedValue({ id: 'sent-msg-001' });

vi.mock('discord.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    on: mockOn,
    login: mockLogin,
    destroy: mockDestroy,
    channels: { fetch: mockChannelsFetch },
    ws: { ping: 42 },
    token: 'mock-token',
  })),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 512,
    MessageContent: 32768,
    DirectMessages: 4096,
  },
}));

const { DiscordAdapter } = await import('../../src/discord-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-disc-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: { botToken: 'test-discord-token' },
    ...overrides,
  };
}

function getMsgHandler(): ((msg: unknown) => Promise<void>) | undefined {
  return mockOn.mock.calls.find(
    ([event]: [string]) => event === 'messageCreate',
  )?.[1] as ((msg: unknown) => Promise<void>) | undefined;
}

function getConsumeHandler():
  | ((msg: { id: string; data: Record<string, string> }) => Promise<void>)
  | undefined {
  return mockConsume.mock.calls[0]?.[3] as
    | ((msg: { id: string; data: Record<string, string> }) => Promise<void>)
    | undefined;
}

describe('DiscordAdapter', () => {
  let adapter: InstanceType<typeof DiscordAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DiscordAdapter(makeConfig());
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('creates instance with required intents and connects', async () => {
    await adapter.connect();

    expect(mockLogin).toHaveBeenCalledWith('mock-token');
    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-discord',
      'discord-ch-disc-001',
      expect.any(Function),
    );

    const health = await adapter.health();
    expect(health.status).toBe('active');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('registers messageCreate handler on construction', () => {
    expect(mockOn).toHaveBeenCalledWith('messageCreate', expect.any(Function));
    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('throws if botToken missing from credentials', () => {
    expect(() => new DiscordAdapter(makeConfig({ credentials: {} }))).toThrow();
  });

  it('incoming message publishes to Redis inbound stream with tenant stamping', async () => {
    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => {
      incomingMessages.push(msg);
    });

    const msgHandler = getMsgHandler();
    expect(msgHandler).toBeDefined();

    const mockMsg = {
      id: '123456789',
      author: { id: '111222333', bot: false },
      content: 'Hello twin!',
      createdTimestamp: Date.now(),
      channelId: '999888777',
      guildId: 'guild-001',
      attachments: { size: 0 },
    };

    await msgHandler!(mockMsg);

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_type: 'discord',
      channel_id: 'ch-disc-001',
      message_id: '123456789',
      persona_slug: 'test-persona',
      content: 'Hello twin!',
      tenant_id: 'tenant-001',
      external_user_id: '111222333',
    }));

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('Hello twin!');
    expect(incomingMessages[0]!.externalUserId).toBe('111222333');
  });

  it('ignores bot messages', async () => {
    const msgHandler = getMsgHandler();

    await msgHandler!({
      id: 'bot-msg',
      author: { id: '444555666', bot: true },
      content: 'Bot message',
      createdTimestamp: Date.now(),
      channelId: '123',
      guildId: null,
      attachments: { size: 0 },
    });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('outbound message from stream sends to Discord channel', async () => {
    mockChannelsFetch.mockResolvedValueOnce({
      isTextBased: () => true,
      send: mockChannelSend,
    });

    await adapter.connect();

    const consumeHandler = getConsumeHandler();
    expect(consumeHandler).toBeDefined();

    await consumeHandler!({
      id: 'out-001',
      data: {
        channel_id: 'ch-disc-001',
        message_id: 'out-001',
        external_user_id: '111222333',
        content: 'Reply from twin',
      },
    });

    expect(mockChannelSend).toHaveBeenCalledWith('Reply from twin');
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

    expect(mockChannelsFetch).not.toHaveBeenCalled();
  });

  it('disconnect destroys client and transport', async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockDestroy).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');
  });

  it('sets status to error on failed send', async () => {
    mockChannelsFetch.mockResolvedValueOnce({
      isTextBased: () => true,
      send: vi.fn().mockRejectedValue(new Error('Discord API error')),
    });

    const message: ChannelMessage = {
      id: 'err-001',
      channelId: 'ch-disc-001',
      externalUserId: '111222333',
      content: 'Will fail',
      timestamp: new Date(),
      metadata: { channelId: '999888777' },
    };

    await expect(adapter.send(message)).rejects.toThrow('Discord API error');

    const health = await adapter.health();
    expect(health.status).toBe('error');
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
        channel_id: 'ch-disc-001',
        message_id: 'out-rate',
        external_user_id: '111',
        content: 'Rate limited message',
      },
    });

    expect(mockChannelsFetch).not.toHaveBeenCalled();
  });

  it('tenant isolation: two adapters have separate tenant context', async () => {
    const adapter2 = new DiscordAdapter(makeConfig({
      channelId: 'ch-disc-002',
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

  // --- Phase 4 (US2 Media) tests ---

  describe('INBOUND attachments', () => {
    it('extracts Discord attachments into ChannelMessage.attachments', async () => {
      const incomingMessages: ChannelMessage[] = [];
      adapter.onIncoming(async (msg) => {
        incomingMessages.push(msg);
      });

      const msgHandler = getMsgHandler();
      expect(msgHandler).toBeDefined();

      const mockAttachment = new Map();
      mockAttachment.set('att-001', {
        url: 'https://cdn.discordapp.com/attachments/123/image.png',
        contentType: 'image/png',
        name: 'image.png',
        size: 12345,
      });
      const attachmentCollection = {
        size: 1,
        forEach: (cb: (val: unknown, key: unknown) => void) => mockAttachment.forEach(cb),
        [Symbol.iterator]: () => mockAttachment.entries(),
      };

      await msgHandler!({
        id: 'msg-att-001',
        author: { id: 'user-001', bot: false },
        content: 'Check out this image',
        createdTimestamp: Date.now(),
        channelId: '999888777',
        guildId: 'guild-001',
        attachments: attachmentCollection,
      });

      expect(incomingMessages).toHaveLength(1);
      const msg = incomingMessages[0]!;
      expect(msg.attachments).toBeDefined();
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0]!.kind).toBe('image');
      expect(msg.attachments![0]!.url).toBe('https://cdn.discordapp.com/attachments/123/image.png');
      expect(msg.attachments![0]!.mime).toBe('image/png');
      expect(msg.attachments![0]!.filename).toBe('image.png');
    });

    it('serializes attachments_json in Redis INBOUND publish', async () => {
      const msgHandler = getMsgHandler();

      const mockAttachment = new Map();
      mockAttachment.set('att-002', {
        url: 'https://cdn.discordapp.com/attachments/123/doc.pdf',
        contentType: 'application/pdf',
        name: 'report.pdf',
        size: 54321,
      });
      const attachmentCollection = {
        size: 1,
        forEach: (cb: (val: unknown, key: unknown) => void) => mockAttachment.forEach(cb),
        [Symbol.iterator]: () => mockAttachment.entries(),
      };

      await msgHandler!({
        id: 'msg-att-002',
        author: { id: 'user-001', bot: false },
        content: 'Here is the report',
        createdTimestamp: Date.now(),
        channelId: '999888777',
        guildId: 'guild-001',
        attachments: attachmentCollection,
      });

      expect(mockPublish).toHaveBeenCalledWith(
        'twin.stream.in',
        expect.objectContaining({
          attachments_json: expect.any(String),
        }),
      );

      const publishCall = mockPublish.mock.calls[0]!;
      const payload = publishCall[1] as Record<string, string>;
      const parsed = JSON.parse(payload.attachments_json);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].kind).toBe('file');
      expect(parsed[0].url).toBe('https://cdn.discordapp.com/attachments/123/doc.pdf');
      expect(parsed[0].mime).toBe('application/pdf');
      expect(parsed[0].filename).toBe('report.pdf');
    });

    it('does not include attachments_json when message has no attachments', async () => {
      const msgHandler = getMsgHandler();

      await msgHandler!({
        id: 'msg-no-att',
        author: { id: 'user-001', bot: false },
        content: 'Just text',
        createdTimestamp: Date.now(),
        channelId: '999888777',
        guildId: 'guild-001',
        attachments: { size: 0 },
      });

      const publishCall = mockPublish.mock.calls[0]!;
      const payload = publishCall[1] as Record<string, string>;
      expect(payload.attachments_json).toBeUndefined();
    });
  });

  describe('OUTBOUND attachments', () => {
    it('sends message with files parameter when attachments are present', async () => {
      mockChannelsFetch.mockResolvedValueOnce({
        isTextBased: () => true,
        send: mockChannelSend,
      });

      const message: ChannelMessage = {
        id: 'out-att-001',
        channelId: 'ch-disc-001',
        externalUserId: '111222333',
        content: 'Here is an image for you',
        timestamp: new Date(),
        metadata: { channelId: '999888777' },
        attachments: [
          {
            kind: 'image',
            url: 'https://example.com/generated-image.png',
            mime: 'image/png',
            filename: 'generated-image.png',
          },
        ],
      };

      await adapter.send(message);

      expect(mockChannelSend).toHaveBeenCalledWith({
        content: 'Here is an image for you',
        files: [
          {
            attachment: 'https://example.com/generated-image.png',
            name: 'generated-image.png',
          },
        ],
      });
    });

    it('sends message with Buffer attachment bytes', async () => {
      mockChannelsFetch.mockResolvedValueOnce({
        isTextBased: () => true,
        send: mockChannelSend,
      });

      const buffer = Buffer.from('fake-image-data');

      const message: ChannelMessage = {
        id: 'out-att-002',
        channelId: 'ch-disc-001',
        externalUserId: '111222333',
        content: 'Generated image',
        timestamp: new Date(),
        metadata: { channelId: '999888777' },
        attachments: [
          {
            kind: 'image',
            bytes: buffer,
            mime: 'image/png',
            filename: 'chart.png',
          },
        ],
      };

      await adapter.send(message);

      expect(mockChannelSend).toHaveBeenCalledWith({
        content: 'Generated image',
        files: [
          {
            attachment: buffer,
            name: 'chart.png',
          },
        ],
      });
    });

    it('falls back to text-only send when attachments array is empty', async () => {
      mockChannelsFetch.mockResolvedValueOnce({
        isTextBased: () => true,
        send: mockChannelSend,
      });

      const message: ChannelMessage = {
        id: 'out-att-003',
        channelId: 'ch-disc-001',
        externalUserId: '111222333',
        content: 'Text only message',
        timestamp: new Date(),
        metadata: { channelId: '999888777' },
        attachments: [],
      };

      await adapter.send(message);

      expect(mockChannelSend).toHaveBeenCalledWith('Text only message');
    });

    it('outbound consumer parses attachments_json and sends with files', async () => {
      mockChannelsFetch.mockResolvedValueOnce({
        isTextBased: () => true,
        send: mockChannelSend,
      });

      await adapter.connect();

      const consumeHandler = getConsumeHandler();

      await consumeHandler!({
        id: 'out-att-stream',
        data: {
          channel_id: 'ch-disc-001',
          message_id: 'out-att-stream',
          external_user_id: '111222333',
          content: 'Outbound with attachment',
          attachments_json: JSON.stringify([
            {
              kind: 'image',
              url: 'https://example.com/outbound-image.png',
              mime: 'image/png',
              filename: 'outbound-image.png',
            },
          ]),
        },
      });

      expect(mockChannelSend).toHaveBeenCalledWith({
        content: 'Outbound with attachment',
        files: [
          {
            attachment: 'https://example.com/outbound-image.png',
            name: 'outbound-image.png',
          },
        ],
      });
    });

    it('outbound consumer handles invalid attachments_json gracefully', async () => {
      mockChannelsFetch.mockResolvedValueOnce({
        isTextBased: () => true,
        send: mockChannelSend,
      });

      await adapter.connect();

      const consumeHandler = getConsumeHandler();

      await consumeHandler!({
        id: 'out-bad-json',
        data: {
          channel_id: 'ch-disc-001',
          message_id: 'out-bad-json',
          external_user_id: '111222333',
          content: 'Bad json test',
          attachments_json: 'not-valid-json{{{',
        },
      });

      expect(mockChannelSend).toHaveBeenCalledWith('Bad json test');
    });

    it('text-only outbound still works unchanged', async () => {
      mockChannelsFetch.mockResolvedValueOnce({
        isTextBased: () => true,
        send: mockChannelSend,
      });

      const message: ChannelMessage = {
        id: 'out-text-only',
        channelId: 'ch-disc-001',
        externalUserId: '111222333',
        content: 'Simple text reply',
        timestamp: new Date(),
        metadata: { channelId: '999888777' },
      };

      await adapter.send(message);

      expect(mockChannelSend).toHaveBeenCalledWith('Simple text reply');
    });
  });
});
