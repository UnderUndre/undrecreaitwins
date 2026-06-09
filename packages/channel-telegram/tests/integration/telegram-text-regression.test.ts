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

function getTextHandler(): ((ctx: unknown) => Promise<void>) | undefined {
  return mockOn.mock.calls.find(
    ([event]: [string]) => event === 'text',
  )?.[1] as ((ctx: unknown) => Promise<void>) | undefined;
}

describe('TelegramAdapter — text-only regression (Phase 4)', () => {
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

  it('processes plain text inbound message without referencing attachments', async () => {
    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => {
      incomingMessages.push(msg);
    });

    const textHandler = getTextHandler();
    expect(textHandler).toBeDefined();

    await textHandler!({
      message: {
        message_id: 100,
        text: 'Hello from Telegram!',
        date: Math.floor(Date.now() / 1000),
      },
      from: { id: 555666777 },
    });

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_id: 'ch-tg-001',
      message_id: '100',
      persona_slug: 'test-persona',
      content: 'Hello from Telegram!',
      tenant_id: 'tenant-001',
      external_user_id: '555666777',
    }));

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('Hello from Telegram!');
    expect(incomingMessages[0]!.externalUserId).toBe('555666777');
    // No attachments field set for text-only
    expect(incomingMessages[0]!.attachments).toBeUndefined();
  });

  it('does not include attachments_json in Redis publish for text messages', async () => {
    const textHandler = getTextHandler();

    await textHandler!({
      message: {
        message_id: 101,
        text: 'Plain text only',
        date: Math.floor(Date.now() / 1000),
      },
      from: { id: 555666777 },
    });

    const publishCall = mockPublish.mock.calls[0]!;
    const payload = publishCall[1] as Record<string, string>;
    expect(payload.attachments_json).toBeUndefined();
  });

  it('sends outbound text message via bot.telegram.sendMessage unchanged', async () => {
    await adapter.connect();

    const consumeHandler = mockConsume.mock.calls[0]?.[3] as
      ((msg: { id: string; data: Record<string, string> }) => Promise<void>) | undefined;
    expect(consumeHandler).toBeDefined();

    await consumeHandler!({
      id: 'out-001',
      data: {
        channel_id: 'ch-tg-001',
        message_id: 'out-001',
        external_user_id: '555666777',
        content: 'Response from twin',
      },
    });

    expect(mockSendMessage).toHaveBeenCalledWith('555666777', 'Response from twin');
  });

  it('gracefully ignores attachments_json in outbound stream data', async () => {
    await adapter.connect();

    const consumeHandler = mockConsume.mock.calls[0]?.[3] as
      ((msg: { id: string; data: Record<string, string> }) => Promise<void>) | undefined;
    expect(consumeHandler).toBeDefined();

    await consumeHandler!({
      id: 'out-with-att',
      data: {
        channel_id: 'ch-tg-001',
        message_id: 'out-with-att',
        external_user_id: '555666777',
        content: 'Text with ignored attachments',
        attachments_json: JSON.stringify([{ kind: 'image', url: 'https://example.com/img.png', mime: 'image/png' }]),
      },
    });

    // Should still just send text — attachments are ignored
    expect(mockSendMessage).toHaveBeenCalledWith('555666777', 'Text with ignored attachments');
  });

  it('outbound consumer ignores messages for other channel_ids', async () => {
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
      externalUserId: '555666777',
      content: 'Will fail',
      timestamp: new Date(),
    };

    await expect(adapter.send(message)).rejects.toThrow('Telegram API error');

    const health = await adapter.health();
    expect(health.status).toBe('error');
  });
});
