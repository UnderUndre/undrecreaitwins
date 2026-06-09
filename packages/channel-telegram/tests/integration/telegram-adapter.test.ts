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

const mockOn = vi.fn();
const mockLaunch = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('telegraf', () => ({
  Telegraf: vi.fn().mockImplementation(() => ({
    on: mockOn,
    launch: mockLaunch,
    stop: mockStop,
    telegram: { sendMessage: mockSendMessage },
  })),
}));

const { TelegramAdapter } = await import('../../src/telegram-adapter.js');

function makeConfig(overrides?: Record<string, string>) {
  return {
    botToken: 'test-bot-token',
    channelId: 'ch-tg-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    ...overrides,
  };
}

describe('TelegramAdapter', () => {
  let adapter: InstanceType<typeof TelegramAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new TelegramAdapter(makeConfig());
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('creates instance and connects', async () => {
    await adapter.connect();

    expect(mockLaunch).toHaveBeenCalled();
    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-telegram',
      'telegram-ch-tg-001',
      expect.any(Function),
    );

    const health = await adapter.health();
    expect(health.status).toBe('active');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('registers text handler on construction', () => {
    expect(mockOn).toHaveBeenCalledWith('text', expect.any(Function));
  });

  it('incoming text message publishes to Redis inbound stream', async () => {
    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => {
      incomingMessages.push(msg);
    });

    const textHandler = mockOn.mock.calls.find(
      ([event]: [string]) => event === 'text',
    )?.[1] as ((ctx: unknown) => Promise<void>) | undefined;
    expect(textHandler).toBeDefined();

    const ctx = {
      message: {
        message_id: 42,
        text: 'Привет, бот!',
        date: Math.floor(Date.now() / 1000),
      },
      from: { id: 987654321 },
    };

    await textHandler!(ctx);

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_id: 'ch-tg-001',
      message_id: '42',
      persona_slug: 'test-persona',
      content: 'Привет, бот!',
      tenant_id: 'tenant-001',
      external_user_id: '987654321',
    }));

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('Привет, бот!');
    expect(incomingMessages[0]!.externalUserId).toBe('987654321');
  });

  it('ignores messages without text or from id', async () => {
    const textHandler = mockOn.mock.calls.find(
      ([event]: [string]) => event === 'text',
    )?.[1] as ((ctx: unknown) => Promise<void>) | undefined;

    await textHandler!({ message: { date: 0 }, from: undefined });
    await textHandler!({ message: { text: '', date: 0 }, from: { id: 1 } });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('outbound message from stream sends via bot', async () => {
    await adapter.connect();

    const consumeHandler = mockConsume.mock.calls[0]?.[3] as
      ((msg: { id: string; data: Record<string, string> }) => Promise<void>) | undefined;
    expect(consumeHandler).toBeDefined();

    await consumeHandler!({
      id: 'out-001',
      data: {
        channel_id: 'ch-tg-001',
        message_id: 'out-001',
        external_user_id: '987654321',
        content: 'Ответ от твина',
      },
    });

    expect(mockSendMessage).toHaveBeenCalledWith('987654321', 'Ответ от твина');
  });

  it('outbound consumer ignores messages for other channels', async () => {
    await adapter.connect();

    const consumeHandler = mockConsume.mock.calls[0]?.[3] as
      ((msg: { id: string; data: Record<string, string> }) => Promise<void>) | undefined;

    await consumeHandler!({
      id: 'out-002',
      data: {
        channel_id: 'ch-other',
        message_id: 'out-002',
        external_user_id: '111',
        content: 'Not for us',
      },
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('disconnect stops bot and transport', async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockStop).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');
  });

  it('sets status to error on failed send', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('Telegram API error'));

    const message: ChannelMessage = {
      id: 'err-001',
      channelId: 'ch-tg-001',
      externalUserId: '987654321',
      content: 'Will fail',
      timestamp: new Date(),
    };

    await expect(adapter.send(message)).rejects.toThrow('Telegram API error');

    const health = await adapter.health();
    expect(health.status).toBe('error');
  });
});
