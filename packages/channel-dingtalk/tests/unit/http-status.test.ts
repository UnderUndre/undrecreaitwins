import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

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

vi.mock('node:http', () => ({
  createServer: vi.fn().mockReturnValue({
    listen: vi.fn().mockImplementation(function (this: unknown, _port: number, cb: () => void) { cb(); return this; }),
    close: vi.fn().mockImplementation(function (this: unknown, cb: () => void) { cb(); return this; }),
    on: vi.fn(),
  }),
  request: vi.fn(),
}));

const mockHttpsRequest = vi.fn();
vi.mock('node:https', () => ({
  request: mockHttpsRequest,
}));

function makeMockRequest(statusCode: number, body: string) {
  return vi.fn().mockImplementation((_url: string, optionsOrCb: unknown, cb?: (res: unknown) => void) => {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : cb;
    const res = new EventEmitter() as (EventEmitter & { statusCode: number });
    res.statusCode = statusCode;

    const req = new EventEmitter() as (EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> });
    req.write = vi.fn();
    req.end = vi.fn().mockImplementation(() => {
      setImmediate(() => {
        if (callback) callback(res);
        setImmediate(() => {
          res.emit('data', Buffer.from(body));
          res.emit('end');
        });
      });
    });

    return req;
  });
}

const { DingTalkAdapter } = await import('../../src/dingtalk-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-dt-unit',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: { appKey: 'test-app-key', appSecret: 'test-app-secret' },
    ...overrides,
  };
}

describe('DingTalkAdapter — httpGet/httpPost non-2xx rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getAccessToken rejects on HTTP 500', async () => {
    mockHttpsRequest.mockImplementation(makeMockRequest(500, 'Internal Server Error'));

    const adapter = new DingTalkAdapter(makeConfig());

    await expect(adapter.getAccessToken()).rejects.toThrow('HTTP 500');
  });

  it('getAccessToken rejects on HTTP 403', async () => {
    mockHttpsRequest.mockImplementation(makeMockRequest(403, '{"errcode":40014,"errmsg":"forbidden"}'));

    const adapter = new DingTalkAdapter(makeConfig());

    await expect(adapter.getAccessToken()).rejects.toThrow('HTTP 403');
  });

  it('getAccessToken succeeds on HTTP 200', async () => {
    mockHttpsRequest.mockImplementation(makeMockRequest(200, '{"errcode":0,"access_token":"valid-token","expires_in":7200}'));

    const adapter = new DingTalkAdapter(makeConfig());

    const token = await adapter.getAccessToken();
    expect(token).toBe('valid-token');
  });

  it('send rejects on HTTP 502', async () => {
    mockHttpsRequest.mockImplementation(makeMockRequest(200, '{"errcode":0,"access_token":"pre-cached-token","expires_in":7200}'));

    const adapter = new DingTalkAdapter(makeConfig());

    const token = await adapter.getAccessToken();
    expect(token).toBe('pre-cached-token');

    mockHttpsRequest.mockImplementation(makeMockRequest(502, 'Bad Gateway'));

    await expect(adapter.send({
      id: 'msg-502',
      channelId: 'ch-dt-unit',
      externalUserId: 'user-502',
      content: 'test',
      timestamp: new Date(),
    })).rejects.toThrow('HTTP 502');
  });
});
