import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  verifyWeComSignature: vi.fn(),
}));

const { verifyWeComSignature } = await import('@undrecreaitwins/core/services/webhook-signature.js');
const { WeComAdapter } = await import('../../src/wecom-adapter.js');

const TEST_TOKEN = 'test-wecom-token';
const TEST_ENCODING_AES_KEY = 'test-encoding-aes-key-1234567890ab';
const TEST_CORP_ID = 'corp-test-001';
const TEST_AGENT_ID = '1000001';

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-wecom-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    port: 0,
    credentials: {
      token: TEST_TOKEN,
      encodingAesKey: TEST_ENCODING_AES_KEY,
      corpId: TEST_CORP_ID,
      agentId: TEST_AGENT_ID,
    },
    ...overrides,
  };
}

function makeWeComXmlMessage(overrides?: Record<string, string>): string {
  const fields = {
    MsgId: 'msg-wecom-001',
    FromUserName: 'user-wecom-001',
    ToUserName: 'to-wecom-001',
    Content: 'Hello from WeCom',
    MsgType: 'text',
    CreateTime: '1609459200',
    AgentID: TEST_AGENT_ID,
    ...overrides,
  };

  let xml = '<xml>';
  for (const [key, value] of Object.entries(fields)) {
    xml += `<${key}><![CDATA[${value}]]></${key}>`;
  }
  xml += '</xml>';
  return xml;
}

describe('WeComAdapter — signature verification', () => {
  let adapter: InstanceType<typeof WeComAdapter>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    (verifyWeComSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('valid signature → message published to INBOUND', async () => {
    const port = 19101;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const body = makeWeComXmlMessage();
    const signature = 'valid-signature';

    (verifyWeComSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const response = await fetch(`http://127.0.0.1:${port}/?msg_signature=${encodeURIComponent(signature)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });

    expect(response.status).toBe(200);

    expect(verifyWeComSignature).toHaveBeenCalledWith(
      body,
      signature,
      TEST_TOKEN,
    );

    expect(mockPublish).toHaveBeenCalledWith('twin.stream.in', expect.objectContaining({
      channel_type: 'wecom',
      channel_id: 'ch-wecom-001',
      message_id: 'msg-wecom-001',
      persona_slug: 'test-persona',
      content: 'Hello from WeCom',
      tenant_id: 'tenant-001',
      external_user_id: 'user-wecom-001',
    }));

    expect(mockRedisSet).toHaveBeenCalledWith(
      'seen:wecom:msg-wecom-001',
      '1',
      'EX',
      300,
      'NX',
    );
  });

  it('forged/invalid signature → 401 returned, no INBOUND publish', async () => {
    const port = 19102;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const body = makeWeComXmlMessage();
    const signature = 'forged-signature';

    (verifyWeComSignature as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await fetch(`http://127.0.0.1:${port}/?msg_signature=${encodeURIComponent(signature)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });

    expect(response.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('replayed message (same message_id twice) → second time acked but not re-published', async () => {
    const port = 19103;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const body = makeWeComXmlMessage();
    const signature = 'valid-sig';

    (verifyWeComSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // First call: SET NX succeeds
    mockRedisSet.mockResolvedValueOnce('OK');

    const response1 = await fetch(`http://127.0.0.1:${port}/?msg_signature=${encodeURIComponent(signature)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });

    expect(response1.status).toBe(200);
    expect(mockPublish).toHaveBeenCalledTimes(1);

    // Second call: SET NX returns null → duplicate
    mockRedisSet.mockResolvedValueOnce(null);

    const response2 = await fetch(`http://127.0.0.1:${port}/?msg_signature=${encodeURIComponent(signature)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });

    expect(response2.status).toBe(200);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('missing signature → 401', async () => {
    const port = 19104;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const body = makeWeComXmlMessage();

    // No msg_signature query param
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });

    expect(response.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(verifyWeComSignature).not.toHaveBeenCalled();
  });

  it('handles GET URL verification with echostr', async () => {
    const port = 19105;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const echostr = 'hello-verify';
    const signature = 'valid-verify-sig';

    (verifyWeComSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const response = await fetch(
      `http://127.0.0.1:${port}/?echostr=${encodeURIComponent(echostr)}&msg_signature=${encodeURIComponent(signature)}`,
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe(echostr);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('GET with invalid signature returns 401', async () => {
    const port = 19106;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const echostr = 'hello-verify';
    const signature = 'invalid-sig';

    (verifyWeComSignature as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await fetch(
      `http://127.0.0.1:${port}/?echostr=${encodeURIComponent(echostr)}&msg_signature=${encodeURIComponent(signature)}`,
    );

    expect(response.status).toBe(401);
  });

  it('throws if required credentials are missing', () => {
    expect(() => new WeComAdapter(makeConfig({
      credentials: { token: '', encodingAesKey: TEST_ENCODING_AES_KEY, corpId: TEST_CORP_ID, agentId: TEST_AGENT_ID },
    }))).toThrow();

    expect(() => new WeComAdapter(makeConfig({
      credentials: { token: TEST_TOKEN, encodingAesKey: '', corpId: TEST_CORP_ID, agentId: TEST_AGENT_ID },
    }))).toThrow();

    expect(() => new WeComAdapter(makeConfig({
      credentials: { token: TEST_TOKEN, encodingAesKey: TEST_ENCODING_AES_KEY, corpId: '', agentId: TEST_AGENT_ID },
    }))).toThrow();

    expect(() => new WeComAdapter(makeConfig({
      credentials: { token: TEST_TOKEN, encodingAesKey: TEST_ENCODING_AES_KEY, corpId: TEST_CORP_ID, agentId: '' },
    }))).toThrow();
  });

  it('onIncoming handler receives the normalized message', async () => {
    const port = 19107;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => {
      incomingMessages.push(msg);
    });

    const body = makeWeComXmlMessage();
    const signature = 'valid-sig';

    (verifyWeComSignature as ReturnType<typeof vi.fn>).mockReturnValue(true);

    await fetch(`http://127.0.0.1:${port}/?msg_signature=${encodeURIComponent(signature)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body,
    });

    expect(incomingMessages).toHaveLength(1);
    expect(incomingMessages[0]!.id).toBe('msg-wecom-001');
    expect(incomingMessages[0]!.externalUserId).toBe('user-wecom-001');
    expect(incomingMessages[0]!.content).toBe('Hello from WeCom');
  });

  it('disconnect closes the server', async () => {
    const port = 19108;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();
    await adapter.disconnect();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');

    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('returns 405 for unsupported methods', async () => {
    const port = 19109;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'PUT',
    });

    expect(response.status).toBe(405);
  });
});
