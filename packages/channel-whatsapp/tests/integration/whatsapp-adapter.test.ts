import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
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

const mockFetch = vi.fn().mockResolvedValue(
  new Response(null, { status: 200, statusText: 'OK' }),
);
vi.stubGlobal('fetch', mockFetch);

const { WhatsAppAdapter } = await import('../../src/whatsapp-adapter.js');

const SECRET = 'test-webhook-secret';

function makeConfig(overrides?: Record<string, string>) {
  return {
    channelId: 'ch-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    evolutionUrl: 'http://localhost:8080',
    instanceId: 'ev-instance-1',
    webhookSecret: SECRET,
    ...overrides,
  };
}

function signPayload(payload: object): string {
  return createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
}

function makeEvolutionPayload(text = 'Hello', remoteJid = '5511999888@s.whatsapp.net') {
  return {
    data: {
      key: {
        id: 'msg-123',
        remoteJid,
      },
      message: {
        conversation: text,
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  };
}

describe('WhatsAppAdapter', () => {
  let adapter: InstanceType<typeof WhatsAppAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(
      new Response(null, { status: 200, statusText: 'OK' }),
    );
    adapter = new WhatsAppAdapter(makeConfig());
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('connects and disconnects (lifecycle)', async () => {
    await adapter.connect();
    const health = await adapter.health();
    expect(health.status).toBe('active');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);

    await adapter.disconnect();
    const afterDisconnect = await adapter.health();
    expect(afterDisconnect.status).toBe('disconnected');
  });

  it('receives webhook message and publishes to inbound stream', async () => {
    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => {
      incomingMessages.push(msg);
    });

    process.env.WEBHOOK_PORT = '0';
    await adapter.connect();
    delete process.env.WEBHOOK_PORT;

    const server = (adapter as unknown as { webhookServer: { inject: (opts: unknown) => Promise<{ statusCode: number; body: string }> } }).webhookServer;
    expect(server).not.toBeNull();

    const payload = makeEvolutionPayload('Hola mundo');
    const signature = signPayload(payload);

    const response = await server.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-signature': signature },
      payload,
    });

    expect(response.statusCode).toBe(200);

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_id: 'ch-001',
      message_id: 'msg-123',
      persona_slug: 'test-persona',
      content: 'Hola mundo',
      tenant_id: 'tenant-001',
      external_user_id: '5511999888@s.whatsapp.net',
    }));

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.content).toBe('Hola mundo');
  });

  it('rejects webhook with invalid signature (401)', async () => {
    process.env.WEBHOOK_PORT = '0';
    await adapter.connect();
    delete process.env.WEBHOOK_PORT;

    const server = (adapter as unknown as { webhookServer: { inject: (opts: unknown) => Promise<{ statusCode: number; body: string }> } }).webhookServer;

    const payload = makeEvolutionPayload('Bad actor');

    const response = await server.inject({
      method: 'POST',
      url: '/webhook',
      headers: { 'x-signature': 'invalid-signature' },
      payload,
    });

    expect(response.statusCode).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('sends outbound message via Evolution API', async () => {
    const message: ChannelMessage = {
      id: 'out-001',
      channelId: 'ch-001',
      externalUserId: '5511999888@s.whatsapp.net',
      content: 'Reply from twin',
      timestamp: new Date(),
    };

    await adapter.send(message);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/message/sendText/ev-instance-1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          number: '5511999888',
          text: 'Reply from twin',
        }),
      }),
    );
  });

  it('retries on 5xx with exponential backoff', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockFetch
      .mockRejectedValueOnce(new Error('Evolution API error: 500'))
      .mockRejectedValueOnce(new Error('Evolution API error: 500'))
      .mockResolvedValueOnce(new Response(null, { status: 200, statusText: 'OK' }));

    const message: ChannelMessage = {
      id: 'retry-001',
      channelId: 'ch-001',
      externalUserId: '5511999888@s.whatsapp.net',
      content: 'Will retry',
      timestamp: new Date(),
    };

    const sendSpy = vi.spyOn(adapter, 'send');

    const promise = (adapter as unknown as { sendWithRetry: (msg: ChannelMessage, attempt?: number) => Promise<void> }).sendWithRetry(message, 0);
    await vi.advanceTimersByTimeAsync(10000);
    await promise;

    expect(sendSpy).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('throws after 5 retry attempts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    mockFetch.mockRejectedValue(new Error('Evolution API error: 500'));

    const message: ChannelMessage = {
      id: 'retry-fail',
      channelId: 'ch-001',
      externalUserId: '5511999888@s.whatsapp.net',
      content: 'Will fail',
      timestamp: new Date(),
    };

    const promise = (adapter as unknown as { sendWithRetry: (msg: ChannelMessage, attempt?: number) => Promise<void> }).sendWithRetry(message, 0);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(60000);

    await expect(promise).rejects.toThrow('Evolution API error: 500');
    expect(mockFetch).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it('sets status to error on failed send', async () => {
    mockFetch.mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    );

    const message: ChannelMessage = {
      id: 'err-001',
      channelId: 'ch-001',
      externalUserId: '5511999888@s.whatsapp.net',
      content: 'Error test',
      timestamp: new Date(),
    };

    await expect(adapter.send(message)).rejects.toThrow('Evolution API error: 500');

    const health = await adapter.health();
    expect(health.status).toBe('error');
  });
});
