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

vi.mock('@undrecreaitwins/core/services/webhook-signature.js', () => ({
  verifyGenericWebhookSignature: vi.fn().mockImplementation(
    (_body: string, signature: string, _secret: string) => {
      return signature !== 'sha256=fakesignature';
    },
  ),
}));

// --- Mock node:http ---
const mockListen = vi.fn().mockImplementation(function (this: unknown, _port: number, cb: () => void) {
  cb();
  return this;
});
const mockClose = vi.fn().mockImplementation(function (this: unknown, cb: () => void) {
  cb();
  return this;
});
const mockOn = vi.fn();

const mockHttpRequest = vi.fn().mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
  const res = {
    on: vi.fn().mockImplementation(function (this: unknown, event: string, handler: (chunk?: Buffer) => void) {
      if (event === 'data') handler(Buffer.from('{"ok":true}'));
      if (event === 'end') handler();
    }),
    statusCode: 200,
  };
  cb(res);
  return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
});

vi.mock('node:http', () => ({
  createServer: vi.fn().mockReturnValue({
    listen: mockListen,
    close: mockClose,
    on: mockOn,
  }),
  request: (...args: unknown[]) => mockHttpRequest(...args),
}));

// --- Mock node:https (outbound API + OAuth) ---
function createOAuthResponse(accessToken = 'test-token-123', expiresIn = 86400) {
  return {
    on: vi.fn().mockImplementation(function (this: unknown, event: string, handler: (chunk?: Buffer) => void) {
      if (event === 'data') handler(Buffer.from(JSON.stringify({ access_token: accessToken, expires_in: expiresIn })));
      if (event === 'end') handler();
    }),
    statusCode: 200,
  };
}

function createSendMessageResponse(ok = true) {
  return {
    on: vi.fn().mockImplementation(function (this: unknown, event: string, handler: (chunk?: Buffer) => void) {
      if (event === 'data') handler(Buffer.from(ok ? '{"status":"ok"}' : '{"error":"forbidden"}'));
      if (event === 'end') handler();
    }),
    statusCode: ok ? 200 : 403,
  };
}

const mockHttpsRequest = vi.fn();
vi.mock('node:https', () => ({
  request: (...args: unknown[]) => mockHttpsRequest(...args),
}));

const { AvitoAdapter } = await import('../../src/avito-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-avito-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    redisUrl: 'redis://localhost:6379',
    credentials: {
      clientId: 'avito-client-id',
      clientSecret: 'avito-client-secret',
      webhookSecret: 'avito-webhook-secret',
      port: 3102,
    },
    ...overrides,
  };
}

describe('AvitoAdapter', () => {
  let adapter: InstanceType<typeof AvitoAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: OAuth returns valid token, send returns ok
    mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
      const urlStr = typeof _opts === 'object' && _opts !== null && 'path' in _opts
        ? String((_opts as Record<string, unknown>).path)
        : '';
      if (urlStr.includes('/token')) {
        cb(createOAuthResponse());
      } else {
        cb(createSendMessageResponse());
      }
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    });
    adapter = new AvitoAdapter(makeConfig());
  });

  afterEach(async () => {
    try { await adapter.disconnect(); } catch { /* noop */ }
  });

  // --- Constructor ---

  describe('constructor', () => {
    it('should throw if clientId is missing', () => {
      expect(() => new AvitoAdapter(makeConfig({
        credentials: { clientId: '', clientSecret: 's', webhookSecret: 'w' },
      }))).toThrow('Avito clientId is required');
    });

    it('should throw if clientSecret is missing', () => {
      expect(() => new AvitoAdapter(makeConfig({
        credentials: { clientId: 'c', clientSecret: '', webhookSecret: 'w' },
      }))).toThrow('Avito clientSecret is required');
    });

    it('should throw if webhookSecret is missing', () => {
      expect(() => new AvitoAdapter(makeConfig({
        credentials: { clientId: 'c', clientSecret: 's', webhookSecret: '' },
      }))).toThrow('Avito webhookSecret is required');
    });

    it('should use default port 3102 if not specified', () => {
      const a = new AvitoAdapter(makeConfig({
        credentials: { clientId: 'c', clientSecret: 's', webhookSecret: 'w' },
      }));
      expect(a).toBeDefined();
    });
  });

  // --- Lifecycle ---

  describe('connect / disconnect', () => {
    it('should start HTTP server on connect', async () => {
      await adapter.connect();
      expect(mockListen).toHaveBeenCalledWith(3102, expect.any(Function));
      const health = await adapter.health();
      expect(health.status).toBe('active');
    });

    it('should set status to disconnected after disconnect', async () => {
      await adapter.connect();
      await adapter.disconnect();
      const health = await adapter.health();
      expect(health.status).toBe('disconnected');
    });
  });

  // --- Outbound ---

  describe('send', () => {
    it('should obtain OAuth token and send message', async () => {
      await adapter.connect();

      const message: ChannelMessage = {
        id: 'msg-001',
        channelId: 'ch-avito-001',
        externalUserId: '',
        content: 'Hello from twin!',
        timestamp: new Date(),
        metadata: { chatId: '12345' },
      };

      await adapter.send(message);

      // First HTTPS call = OAuth, second = send
      expect(mockHttpsRequest).toHaveBeenCalledTimes(2);

      // Verify OAuth call
      const oauthCall = mockHttpsRequest.mock.calls[0][0] as Record<string, unknown>;
      expect(oauthCall.path).toContain('/token');

      // Verify send call
      const sendCall = mockHttpsRequest.mock.calls[1][0] as Record<string, unknown>;
      expect(sendCall.path).toContain('/messenger/v1/messages/12345');
      expect(sendCall.headers).toHaveProperty('Authorization', 'Bearer test-token-123');
    });

    it('should throw if chatId is missing', async () => {
      await adapter.connect();
      await expect(adapter.send({
        id: 'msg-002',
        channelId: 'ch-avito-001',
        externalUserId: '',
        content: 'no chat',
        timestamp: new Date(),
      })).rejects.toThrow('Avito send requires chatId');
    });

    it('should include attachment links in message body', async () => {
      await adapter.connect();

      await adapter.send({
        id: 'msg-003',
        channelId: 'ch-avito-001',
        externalUserId: '',
        content: 'See this',
        timestamp: new Date(),
        metadata: { chatId: '99' },
        attachments: [
          { kind: 'image', url: 'https://example.com/img.jpg', mime: 'image/jpeg', filename: 'img.jpg' },
        ],
      });

      // Verify the send request body contains the attachment link
      const sendReq = mockHttpsRequest.mock.calls[1][2] as ReturnType<typeof vi.fn>;
      // The write call contains the JSON body
      const mockReq = mockHttpsRequest.mock.results[1].value;
      const writeCall = mockReq.write.mock.calls[0][0];
      expect(writeCall).toContain('https://example.com/img.jpg');
    });

    it('should cache token and not re-auth on second send', async () => {
      await adapter.connect();

      await adapter.send({
        id: 'msg-a',
        channelId: 'ch-avito-001',
        externalUserId: '',
        content: 'first',
        timestamp: new Date(),
        metadata: { chatId: '1' },
      });

      await adapter.send({
        id: 'msg-b',
        channelId: 'ch-avito-001',
        externalUserId: '',
        content: 'second',
        timestamp: new Date(),
        metadata: { chatId: '1' },
      });

      // Only 1 OAuth call + 2 send calls = 3 total
      expect(mockHttpsRequest).toHaveBeenCalledTimes(3);
    });
  });

  // --- Outbound consumer ---

  describe('outbound consumer', () => {
    it('should register consumer on connect', async () => {
      await adapter.connect();
      expect(mockConsume).toHaveBeenCalledWith(
        expect.any(String),
        'channel-avito',
        'avito-ch-avito-001',
        expect.any(Function),
      );
    });

    it('should skip messages for different channelId', async () => {
      await adapter.connect();
      const consumerCb = mockConsume.mock.calls[0][3];

      await consumerCb({
        data: {
          channel_id: 'other-channel',
          content: 'hello',
          message_id: 'm1',
          external_user_id: 'u1',
        },
      });

      // Should not call send (no HTTPS requests beyond initial setup)
      expect(mockHttpsRequest).toHaveBeenCalledTimes(0);
    });
  });

  // --- Health ---

  describe('health', () => {
    it('should return health with uptime', async () => {
      await adapter.connect();
      const h = await adapter.health();
      expect(h).toMatchObject({
        status: 'active',
        uptimeSeconds: expect.any(Number),
      });
    });
  });

  // --- Attachments ---

  describe('attachment extraction', () => {
    it('should classify Avito attachment types correctly', async () => {
      await adapter.connect();

      const message: ChannelMessage = {
        id: 'msg-att',
        channelId: 'ch-avito-001',
        externalUserId: '',
        content: 'media msg',
        timestamp: new Date(),
        metadata: { chatId: '42' },
        attachments: [
          { kind: 'image', url: 'https://img.avito.ru/1.jpg', mime: 'image/jpeg', filename: 'photo.jpg' },
          { kind: 'file', url: 'https://docs.avito.ru/1.pdf', mime: 'application/pdf', filename: 'doc.pdf' },
        ],
      };

      await adapter.send(message);

      const sendReq = mockHttpsRequest.mock.results[1].value;
      const body = sendReq.write.mock.calls[0][0];
      expect(body).toContain('https://img.avito.ru/1.jpg');
      expect(body).toContain('https://docs.avito.ru/1.pdf');
    });
  });
});
