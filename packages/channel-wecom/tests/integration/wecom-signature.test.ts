import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelMessage } from '@undrecreaitwins/shared';
import { createCipheriv, randomBytes, createHash } from 'node:crypto';

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

const { WeComAdapter } = await import('../../src/wecom-adapter.js');

const TEST_TOKEN = 'testwecomtoken123';
const TEST_ENCODING_AES_KEY = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
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

function encryptWeComMsg(text: string): string {
  const key = Buffer.from(TEST_ENCODING_AES_KEY + '=', 'base64');
  const iv = key.subarray(0, 16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);

  const random = randomBytes(16);
  const msgLenBuf = Buffer.alloc(4);
  msgLenBuf.writeUInt32BE(Buffer.byteLength(text), 0);
  const corpIdBuf = Buffer.from(TEST_CORP_ID);
  const msgBuf = Buffer.from(text);

  let payload = Buffer.concat([random, msgLenBuf, msgBuf, corpIdBuf]);

  const pad = 32 - (payload.length % 32);
  const padBuf = Buffer.alloc(pad, pad);
  payload = Buffer.concat([payload, padBuf]);

  return Buffer.concat([cipher.update(payload), cipher.final()]).toString('base64');
}

function makeWeComXmlMessage(overrides?: Record<string, string>): { xml: string, signature: string, timestamp: string, nonce: string } {
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

  let rawXml = '<xml>';
  for (const [key, value] of Object.entries(fields)) {
    rawXml += `<${key}><![CDATA[${value}]]></${key}>`;
  }
  rawXml += '</xml>';

  const encrypted = encryptWeComMsg(rawXml);
  
  const timestamp = '1609459200';
  const nonce = 'random-nonce-123';
  const arr = [TEST_TOKEN, timestamp, nonce, encrypted].sort();
  const signature = createHash('sha1').update(arr.join('')).digest('hex');

  const xml = `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`;
  return { xml, signature, timestamp, nonce };
}

describe('WeComAdapter — signature verification', () => {
  let adapter: InstanceType<typeof WeComAdapter>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
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

    const payload = makeWeComXmlMessage();

    const response = await fetch(`http://127.0.0.1:${port}/?msg_signature=${payload.signature}&timestamp=${payload.timestamp}&nonce=${payload.nonce}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: payload.xml,
    });

    expect(response.status).toBe(200);

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

    const payload = makeWeComXmlMessage();

    const response = await fetch(`http://127.0.0.1:${port}/?msg_signature=forged&timestamp=${payload.timestamp}&nonce=${payload.nonce}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: payload.xml,
    });

    expect(response.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it('replayed message (same message_id twice) → second time acked but not re-published', async () => {
    const port = 19103;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const payload = makeWeComXmlMessage();

    // First call: SET NX succeeds
    mockRedisSet.mockResolvedValueOnce('OK');

    const response1 = await fetch(`http://127.0.0.1:${port}/?msg_signature=${payload.signature}&timestamp=${payload.timestamp}&nonce=${payload.nonce}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: payload.xml,
    });

    expect(response1.status).toBe(200);
    expect(mockPublish).toHaveBeenCalledTimes(1);

    // Second call: SET NX returns null → duplicate
    mockRedisSet.mockResolvedValueOnce(null);

    const response2 = await fetch(`http://127.0.0.1:${port}/?msg_signature=${payload.signature}&timestamp=${payload.timestamp}&nonce=${payload.nonce}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: payload.xml,
    });

    expect(response2.status).toBe(200);
    expect(mockPublish).toHaveBeenCalledTimes(1); // Still 1
  });

  it('missing signature → 401', async () => {
    const port = 19104;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const payload = makeWeComXmlMessage();

    const response = await fetch(`http://127.0.0.1:${port}/?timestamp=${payload.timestamp}&nonce=${payload.nonce}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: payload.xml,
    });

    expect(response.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('handles GET URL verification with echostr', async () => {
    const port = 19105;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const echostrRaw = 'hello-verify';
    const encryptedEchostr = encryptWeComMsg(echostrRaw);
    
    const timestamp = '1609459200';
    const nonce = 'random-nonce-123';
    const arr = [TEST_TOKEN, timestamp, nonce, encryptedEchostr].sort();
    const signature = createHash('sha1').update(arr.join('')).digest('hex');

    const response = await fetch(
      `http://127.0.0.1:${port}/?echostr=${encodeURIComponent(encryptedEchostr)}&msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe(echostrRaw);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('GET with invalid signature returns 401', async () => {
    const port = 19106;
    adapter = new WeComAdapter(makeConfig({ port }));
    await adapter.connect();

    const echostrRaw = 'hello-verify';
    const encryptedEchostr = encryptWeComMsg(echostrRaw);
    const timestamp = '1609459200';
    const nonce = 'random-nonce-123';
    const signature = 'invalid-sig';

    const response = await fetch(
      `http://127.0.0.1:${port}/?echostr=${encodeURIComponent(encryptedEchostr)}&msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
    );

    expect(response.status).toBe(401);
  });

  it('throws if required credentials are missing', () => {
    expect(() => new WeComAdapter(makeConfig({ credentials: {} }))).toThrow('WeCom token is required');
  });

  it('onIncoming handler receives the normalized message', async () => {
    const port = 19107;
    adapter = new WeComAdapter(makeConfig({ port }));

    const incomingMessages: ChannelMessage[] = [];
    adapter.onIncoming(async (msg) => {
      incomingMessages.push(msg);
    });

    await adapter.connect();

    const payload = makeWeComXmlMessage();

    await fetch(`http://127.0.0.1:${port}/?msg_signature=${payload.signature}&timestamp=${payload.timestamp}&nonce=${payload.nonce}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: payload.xml,
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
    
    // Test if server is listening
    const response1 = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET' });
    expect(response1.status).toBe(200); // ok for empty GET

    await adapter.disconnect();

    // Second fetch should fail (connection refused)
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
