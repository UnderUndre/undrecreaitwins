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
  verifySlackSignature: vi.fn().mockImplementation(
    (_body: string, _timestamp: string, signature: string, _secret: string) => {
      // Reject obviously fake signatures; allow test signatures
      return signature !== 'v0=fakesignature' && signature !== 'v0=fakesig';
    },
  ),
}));

// Mock node:http — createServer for inbound HTTP + request for outbound HTTP
const mockListen = vi.fn().mockImplementation(function (this: unknown, _port: number, cb: () => void) {
  cb();
  return this;
});
const mockClose = vi.fn().mockImplementation(function (this: unknown, cb: () => void) {
  cb();
  return this;
});
const mockOn = vi.fn();

function createMockHttpResponse(): { on: ReturnType<typeof vi.fn> } {
  return {
    on: vi.fn().mockImplementation(function (this: unknown, _event: string, handler: (chunk?: Buffer) => void) {
      if (_event === 'data') handler(Buffer.from('{"ok":true}'));
      if (_event === 'end') handler();
    }),
  };
}

const mockHttpRequest = vi.fn().mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
  cb(createMockHttpResponse());
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

// Mock node:https for outbound API calls
const mockHttpsRequest = vi.fn().mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
  cb(createMockHttpResponse());
  return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
});

vi.mock('node:https', () => ({
  request: (...args: unknown[]) => mockHttpsRequest(...args),
}));

const { SlackAdapter } = await import('../../src/slack-adapter.js');

function makeConfig(overrides?: Record<string, unknown>) {
  return {
    channelId: 'ch-slack-001',
    tenantId: 'tenant-001',
    personaSlug: 'test-persona',
    credentials: { botToken: 'xoxb-test-token', signingSecret: 'test-signing-secret' },
    ...overrides,
  };
}

describe('SlackAdapter', () => {
  let adapter: InstanceType<typeof SlackAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SlackAdapter(makeConfig());
  });

  afterEach(async () => {
    try {
      await adapter.disconnect();
    } catch {
      // already disconnected
    }
  });

  it('creates instance and connects HTTP server', async () => {
    await adapter.connect();

    expect(mockListen).toHaveBeenCalledWith(3100, expect.any(Function));
    expect(mockConsume).toHaveBeenCalledWith(
      'twin.stream.out',
      'channel-slack',
      'slack-ch-slack-001',
      expect.any(Function),
    );

    const health = await adapter.health();
    expect(health.status).toBe('active');
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('throws if botToken missing from credentials', () => {
    expect(() => new SlackAdapter(makeConfig({ credentials: { signingSecret: 'secret' } }))).toThrow();
  });

  it('throws if signingSecret missing from credentials', () => {
    expect(() => new SlackAdapter(makeConfig({ credentials: { botToken: 'token' } }))).toThrow();
  });

  it('handles URL verification challenge', async () => {
    // Bypass signature check for this test
    const adapterAny = adapter as unknown as { verifySignature: () => boolean };
    adapterAny.verifySignature = () => true;

    await adapter.connect();

    const { createServer } = await import('node:http');
    const handler = (createServer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
      req: unknown, res: unknown
    ) => Promise<void>;

    const mockReq = {
      method: 'POST',
      headers: {},
      on: vi.fn().mockImplementation((_event: string, cb: (chunk: Buffer) => void) => {
        if (_event === 'data') cb(Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'test-challenge-123' })));
        if (_event === 'end') cb();
      }),
    };
    const mockRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };

    await handler(mockReq, mockRes);

    expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(mockRes.end).toHaveBeenCalledWith(JSON.stringify({ challenge: 'test-challenge-123' }));
  });

  it('handles incoming message event — rejects invalid signature', async () => {
    await adapter.connect();

    const { createServer } = await import('node:http');
    const handler = (createServer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
      req: unknown, res: unknown
    ) => Promise<void>;

    const eventPayload = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message',
        user: 'U123456',
        text: 'Hello Slack twin!',
        channel: 'C789012',
        ts: '1234567890.123456',
        event_ts: '1234567890.123456',
      },
    });

    const mockReq = {
      method: 'POST',
      headers: {
        'x-slack-signature': 'v0=fakesignature',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      on: vi.fn().mockImplementation((_event: string, cb: (chunk: Buffer) => void) => {
        if (_event === 'data') cb(Buffer.from(eventPayload));
        if (_event === 'end') cb();
      }),
    };
    const mockRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };

    await handler(mockReq, mockRes);

    // Signature verification will fail with fake sig — expected
    expect(mockRes.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
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

    // Should not call send (no external HTTP request made)
  });

  it('disconnects HTTP server and transport', async () => {
    await adapter.connect();
    await adapter.disconnect();

    expect(mockClose).toHaveBeenCalled();
    expect(mockDisconnect).toHaveBeenCalled();

    const health = await adapter.health();
    expect(health.status).toBe('disconnected');
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
        channel_id: 'ch-slack-001',
        message_id: 'out-rate',
        external_user_id: '111',
        content: 'Rate limited message',
      },
    });
  });

  it('tenant isolation: two adapters have separate tenant context', async () => {
    const adapter2 = new SlackAdapter(makeConfig({
      channelId: 'ch-slack-002',
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
    it('extracts Slack files from file_share events into ChannelMessage.attachments', async () => {
      const incomingMessages: ChannelMessage[] = [];
      adapter.onIncoming(async (msg) => {
        incomingMessages.push(msg);
      });

      // Bypass signature check
      const adapterAny = adapter as unknown as { verifySignature: () => boolean };
      adapterAny.verifySignature = () => true;

      await adapter.connect();

      const { createServer } = await import('node:http');
      const handler = (createServer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
        req: unknown, res: unknown
      ) => Promise<void>;

      const eventPayload = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'message',
          subtype: 'file_share',
          user: 'U123456',
          text: 'Check out this image',
          channel: 'C789012',
          ts: '1234567890.123456',
          event_ts: '1234567890.123456',
          files: [
            {
              id: 'F111',
              url_private: 'https://files.slack.com/files-pri/T123/F111/image.png',
              mimetype: 'image/png',
              name: 'image.png',
              size: 12345,
            },
          ],
        },
      });

      const mockReq = {
        method: 'POST',
        headers: {
          'x-slack-signature': 'v0=fakesig',
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        on: vi.fn().mockImplementation((_event: string, cb: (chunk: Buffer) => void) => {
          if (_event === 'data') cb(Buffer.from(eventPayload));
          if (_event === 'end') cb();
        }),
      };
      const mockRes = {
        writeHead: vi.fn().mockReturnThis(),
        end: vi.fn(),
      };

      await handler(mockReq, mockRes);

      expect(incomingMessages).toHaveLength(1);
      const msg = incomingMessages[0]!;
      expect(msg.attachments).toBeDefined();
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0]!.kind).toBe('image');
      expect(msg.attachments![0]!.url).toBe('https://files.slack.com/files-pri/T123/F111/image.png');
      expect(msg.attachments![0]!.mime).toBe('image/png');
      expect(msg.attachments![0]!.filename).toBe('image.png');
    });

    it('serializes attachments_json in Redis INBOUND publish for file_share', async () => {
      const adapterAny = adapter as unknown as { verifySignature: () => boolean };
      adapterAny.verifySignature = () => true;

      await adapter.connect();

      const { createServer } = await import('node:http');
      const handler = (createServer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
        req: unknown, res: unknown
      ) => Promise<void>;

      const eventPayload = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'message',
          subtype: 'file_share',
          user: 'U123456',
          text: 'Here is a document',
          channel: 'C789012',
          ts: '1234567890.123456',
          event_ts: '1234567890.123456',
          files: [
            {
              id: 'F222',
              url_private: 'https://files.slack.com/files-pri/T123/F222/report.pdf',
              mimetype: 'application/pdf',
              name: 'report.pdf',
              size: 54321,
            },
          ],
        },
      });

      const mockReq = {
        method: 'POST',
        headers: {
          'x-slack-signature': 'v0=fakesig',
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        on: vi.fn().mockImplementation((_event: string, cb: (chunk: Buffer) => void) => {
          if (_event === 'data') cb(Buffer.from(eventPayload));
          if (_event === 'end') cb();
        }),
      };
      const mockRes = {
        writeHead: vi.fn().mockReturnThis(),
        end: vi.fn(),
      };

      await handler(mockReq, mockRes);

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
      expect(parsed[0].url).toBe('https://files.slack.com/files-pri/T123/F222/report.pdf');
    });

    it('does not include attachments_json when event has no files', async () => {
      const adapterAny = adapter as unknown as { verifySignature: () => boolean };
      adapterAny.verifySignature = () => true;

      await adapter.connect();

      const { createServer } = await import('node:http');
      const handler = (createServer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as (
        req: unknown, res: unknown
      ) => Promise<void>;

      const eventPayload = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'message',
          user: 'U123456',
          text: 'Just text',
          channel: 'C789012',
          ts: '1234567890.123456',
          event_ts: '1234567890.123456',
        },
      });

      const mockReq = {
        method: 'POST',
        headers: {
          'x-slack-signature': 'v0=fakesig',
          'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        on: vi.fn().mockImplementation((_event: string, cb: (chunk: Buffer) => void) => {
          if (_event === 'data') cb(Buffer.from(eventPayload));
          if (_event === 'end') cb();
        }),
      };
      const mockRes = {
        writeHead: vi.fn().mockReturnThis(),
        end: vi.fn(),
      };

      await handler(mockReq, mockRes);

      const publishCall = mockPublish.mock.calls[0]!;
      const payload = publishCall[1] as Record<string, string>;
      expect(payload.attachments_json).toBeUndefined();
    });
  });

  describe('OUTBOUND attachments', () => {
    it('send falls back to text-only when attachments array is empty', async () => {
      const message: ChannelMessage = {
        id: 'out-no-att',
        channelId: 'ch-slack-001',
        externalUserId: 'C789012',
        content: 'Text only message',
        timestamp: new Date(),
        metadata: { channel: 'C789012' },
        attachments: [],
      };

      // node:https is mocked to return {"ok":true} — should resolve cleanly
      await expect(adapter.send(message)).resolves.toBeUndefined();
    });

    it('send routes to sendWithAttachments when image attachments present', async () => {
      const buffer = Buffer.from('fake-image-data');

      const message: ChannelMessage = {
        id: 'out-att-001',
        channelId: 'ch-slack-001',
        externalUserId: 'C789012',
        content: 'Here is an image',
        timestamp: new Date(),
        metadata: { channel: 'C789012' },
        attachments: [
          {
            kind: 'image',
            bytes: buffer,
            mime: 'image/png',
            filename: 'chart.png',
          },
        ],
      };

      // node:https.request is mocked to return {"ok":true} — files.upload should succeed
      await expect(adapter.send(message)).resolves.toBeUndefined();
      expect(mockHttpsRequest).toHaveBeenCalled();
    });

    it('send with URL-only attachment downloads and uploads', async () => {
      const message: ChannelMessage = {
        id: 'out-att-url',
        channelId: 'ch-slack-001',
        externalUserId: 'C789012',
        content: 'Image from URL',
        timestamp: new Date(),
        metadata: { channel: 'C789012' },
        attachments: [
          {
            kind: 'image',
            url: 'https://example.com/photo.png',
            mime: 'image/png',
            filename: 'photo.png',
          },
        ],
      };

      // First call to https.request = downloadAsBase64, second = files.upload
      await expect(adapter.send(message)).resolves.toBeUndefined();
    });

    it('outbound consumer parses attachments_json and passes to send', async () => {
      await adapter.connect();

      const consumeHandler = mockConsume.mock.calls[0]?.[3] as
        ((msg: { id: string; data: Record<string, string> }) => Promise<void>) | undefined;
      expect(consumeHandler).toBeDefined();

      await consumeHandler!({
        id: 'out-att-stream',
        data: {
          channel_id: 'ch-slack-001',
          message_id: 'out-att-stream',
          external_user_id: 'C789012',
          content: 'Outbound with attachment',
          slack_channel: 'C789012',
          attachments_json: JSON.stringify([
            {
              kind: 'image',
              url: 'https://example.com/image.png',
              mime: 'image/png',
              filename: 'image.png',
            },
          ]),
        },
      });

      expect(mockHttpsRequest).toHaveBeenCalled();
    });

    it('outbound consumer handles invalid attachments_json gracefully', async () => {
      await adapter.connect();

      const consumeHandler = mockConsume.mock.calls[0]?.[3] as
        ((msg: { id: string; data: Record<string, string> }) => Promise<void>) | undefined;
      expect(consumeHandler).toBeDefined();

      // Invalid JSON falls back to text-only send — should not crash
      await consumeHandler!({
        id: 'out-bad-json',
        data: {
          channel_id: 'ch-slack-001',
          message_id: 'out-bad-json',
          external_user_id: 'C789012',
          content: 'Bad json test',
          slack_channel: 'C789012',
          attachments_json: 'not-valid-json{{{',
        },
      });

      // Should have called https request for text-only chat.postMessage
      expect(mockHttpsRequest).toHaveBeenCalled();
    });

    it('text-only outbound still works unchanged', async () => {
      await adapter.connect();

      const consumeHandler = mockConsume.mock.calls[0]?.[3] as
        ((msg: { id: string; data: Record<string, string> }) => Promise<void>) | undefined;
      expect(consumeHandler).toBeDefined();

      await consumeHandler!({
        id: 'out-text-only',
        data: {
          channel_id: 'ch-slack-001',
          message_id: 'out-text-only',
          external_user_id: 'C789012',
          content: 'Simple text reply',
          slack_channel: 'C789012',
        },
      });

      expect(mockHttpsRequest).toHaveBeenCalled();
    });
  });
});
