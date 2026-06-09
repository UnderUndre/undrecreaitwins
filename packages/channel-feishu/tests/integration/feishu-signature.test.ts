import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { ChannelMessage } from '@undrecreaitwins/shared';

const mockPublish = vi.fn().mockResolvedValue('0-0');
const mockConsume = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisQuit = vi.fn().mockResolvedValue('OK');

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

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    set: mockRedisSet,
    quit: mockRedisQuit,
  })),
}));

vi.mock('@undrecreaitwins/core/services/webhook-signature.js', () => ({
  verifyFeishuSignature: vi.fn(),
}));

const { verifyFeishuSignature } = await import('@undrecreaitwins/core/services/webhook-signature.js');
const { FeishuAdapter } = await import('../../src/feishu-adapter.js');

const TEST_ENCRYPT_KEY = 'test-encrypt-key-1234567890abcdef';
const TEST_VERIFICATION_TOKEN = 'test-verification-token';

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-feishu-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    port: 0, // let OS assign port
    credentials: {
      verificationToken: TEST_VERIFICATION_TOKEN,
      encryptKey: TEST_ENCRYPT_KEY,
    },
    ...overrides,
  };
}

function computeFeishuSignature(timestamp: string, nonce: string, body: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(timestamp + nonce + body);
  return hmac.digest('hex');
}

function makeFeishuEvent(overrides?: Record<string, unknown>): string {
  const event = {
    schema: '2.0',
    header: {
      event_id: 'evt-001',
      event_type: 'im.message.receive_v1',
      token: TEST_VERIFICATION_TOKEN,
      create_time: '1609459200000',
    },
    event: {
      sender: {
        sender_id: { open_id: 'user-open-001', user_id: 'user-001' },
      },
      message: {
        message_id: 'msg-001',
        chat_id: 'chat-001',
        content: '{"text":"Hello from Feishu"}',
        msg_type: 'text',
      },
    },
    ...overrides,
  };
  return JSON.stringify(event);
}

async function getAdapterPort(adapter: InstanceType<typeof FeishuAdapter>): Promise<number> {
  // Access the server's address — the adapter stores it internally
  // We'll use a fixed port in tests instead
  return 9876;
}

describe('FeishuAdapter — signature verification', () => {
  let adapter: InstanceType<typeof FeishuAdapter>;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    (verifyFeishuSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('valid signature → message published to INBOUND', async () => {
    const port = 19081;
    adapter = new FeishuAdapter(makeConfig({ port }));
    await adapter.connect();

    const body = makeFeishuEvent();
    const timestamp = '1609459200';
    const nonce = 'nonce-abc';
    const signature = 'valid-signature';

    (verifyFeishuSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lark-Request-Timestamp': timestamp,
        'X-Lark-Request-Nonce': nonce,
        'X-Lark-Signature': signature,
      },
      body,
    });

    expect(response.status).toBe(200);

    expect(verifyFeishuSignature).toHaveBeenCalledWith(
      timestamp,
      nonce,
      body,
      signature,
      TEST_ENCRYPT_KEY,
    );

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_type: 'feishu',
      channel_id: 'ch-feishu-001',
      message_id: 'msg-001',
      persona_slug: 'test-persona',
      content: '{"text":"Hello from Feishu"}',
      tenant_id: 'tenant-001',
      external_user_id: 'user-open-001',
    }));

    expect(mockRedisSet).toHaveBeenCalledWith(
      'seen:feishu:msg-001',
      '1',
      'EX',
      300,
      'NX',
    );
  });

  it('forged/invalid signature → 401 returned, no INBOUND publish', async () => {
    const port = 19082;
    adapter = new FeishuAdapter(makeConfig({ port }));
    await adapter.connect();

    const body = makeFeishuEvent();
    const timestamp = '1609459200';
    const nonce = 'nonce-abc';
    const signature = 'forged-signature';

    (verifyFeishuSignature as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lark-Request-Timestamp': timestamp,
        'X-Lark-Request-Nonce': nonce,
        'X-Lark-Signature': signature,
      },
      body,
    });

    expect(response.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('replayed message (same message_id twice) → second time acked but not re-published', async () => {
    const port = 19083;
    adapter = new FeishuAdapter(makeConfig({ port }));
    await adapter.connect();

    const body = makeFeishuEvent();
    const timestamp = '1609459200';
    const nonce = 'nonce-abc';
    const signature = 'valid-sig';

    (verifyFeishuSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // First call: SET NX succeeds → message processed
    mockRedisSet.mockResolvedValueOnce('OK');

    const response1 = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lark-Request-Timestamp': timestamp,
        'X-Lark-Request-Nonce': nonce,
        'X-Lark-Signature': signature,
      },
      body,
    });

    expect(response1.status).toBe(200);
    expect(mockPublish).toHaveBeenCalledTimes(1);

    // Second call: SET NX returns null → duplicate detected
    mockRedisSet.mockResolvedValueOnce(null);

    const response2 = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lark-Request-Timestamp': timestamp,
        'X-Lark-Request-Nonce': nonce,
        'X-Lark-Signature': signature,
      },
      body,
    });

    expect(response2.status).toBe(200);
    // Should NOT have been published again
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('missing signature header → 401', async () => {
    const port = 19084;
    adapter = new FeishuAdapter(makeConfig({ port }));
    await adapter.connect();

    const body = makeFeishuEvent();

    // No signature headers at all
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
    });

    expect(response.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(verifyFeishuSignature).not.toHaveBeenCalled();
  });

  it('handles URL verification challenge', async () => {
    const port = 19085;
    adapter = new FeishuAdapter(makeConfig({ port }));
    await adapter.connect();

    const challengeBody = JSON.stringify({
      challenge: 'test-challenge-token',
      token: TEST_VERIFICATION_TOKEN,
    });

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: challengeBody,
    });

    expect(response.status).toBe(200);
    const data = await response.json() as { challenge: string };
    expect(data.challenge).toBe('test-challenge-token');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('throws if required credentials are missing', () => {
    expect(() => new FeishuAdapter(makeConfig({
      credentials: { verificationToken: '', encryptKey: TEST_ENCRYPT_KEY },
    }))).toThrow();

    expect(() => new FeishuAdapter(makeConfig({
      credentials: { verificationToken: TEST_VERIFICATION_TOKEN, encryptKey: '' },
    }))).toThrow();
  });

  it('onIncoming handler receives the normalized message', async () => {
    const port = 19086;
    adapter = new FeishuAdapter(makeConfig({ port }));
    await adapter.connect();

    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => {
      incomingMessages.push(msg);
    });

    const body = makeFeishuEvent();
    const timestamp = '1609459200';
    const nonce = 'nonce-abc';
    const signature = 'valid-sig';

    (verifyFeishuSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Lark-Request-Timestamp': timestamp,
        'X-Lark-Request-Nonce': nonce,
        'X-Lark-Signature': signature,
      },
      body,
    });

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.id).toBe('msg-001');
    expect(incomingMessages[0]!.externalUserId).toBe('user-open-001');
    expect(incomingMessages[0]!.content).toBe('Hello from Feishu');
  });

  it('disconnect closes the server', async () => {
    const port = 19087;
    adapter = new FeishuAdapter(makeConfig({ port }));
    await adapter.connect();
    await adapter.disconnect();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');

    // Server should no longer accept connections
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('returns 405 for non-POST methods', async () => {
    const port = 19088;
    adapter = new FeishuAdapter(makeConfig({ port }));
    await adapter.connect();

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'PUT',
    });

    expect(response.status).toBe(405);
  });
});
