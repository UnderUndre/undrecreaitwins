import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import { verifyGenericWebhookSignature } from '@undrecreaitwins/core/services/webhook-signature.js';
import pino from 'pino';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';

const logger = pino({ name: 'avito-adapter' });

const AVITO_API_BASE = 'https://api.avito.ru';

/** Avito webhook V3 payload structure */
interface AvitoWebhookPayload {
  type: string;
  payload: {
    chat_id?: number;
    user_id?: number;
    message?: {
      id?: number;
      body?: string;
      created_at?: string;
      author_id?: number;
      type?: string;
      attachments?: AvitoAttachment[];
    };
  };
}

interface AvitoAttachment {
  type: string;
  url?: string;
  filename?: string;
  size?: number;
  media?: string;
}

/** Token cache to avoid re-auth on every outbound call */
interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

function classifyAvitoAttachmentKind(type: string): 'image' | 'audio' | 'video' | 'file' {
  if (type === 'image' || type === 'photo') return 'image';
  if (type === 'audio' || type === 'voice') return 'audio';
  if (type === 'video') return 'video';
  return 'file';
}

function extractAvitoAttachments(attachments?: AvitoAttachment[]): import('@undrecreaitwins/shared').ChannelAttachment[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map((a) => ({
    kind: classifyAvitoAttachmentKind(a.type),
    url: a.url ?? a.media,
    mime: guessMime(a.type, a.filename),
    filename: a.filename,
  }));
}

function guessMime(type: string, filename?: string): string {
  if (type === 'image' || type === 'photo') return 'image/jpeg';
  if (type === 'audio' || type === 'voice') return 'audio/mpeg';
  if (type === 'video') return 'video/mp4';
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') return 'application/pdf';
    if (ext === 'png') return 'image/png';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  }
  return 'application/octet-stream';
}

export class AvitoAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private clientId: string;
  private clientSecret: string;
  private webhookSecret: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private server: Server;
  private port: number;
  private tokenCache: TokenCache | null = null;
  private tokenPromise: Promise<string> | null = null;
  private seenMessages: Map<string, number> = new Map();
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const clientId = config.credentials['clientId'];
    if (typeof clientId !== 'string' || clientId.length === 0) {
      throw new AppError('Avito clientId is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    const clientSecret = config.credentials['clientSecret'];
    if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
      throw new AppError('Avito clientSecret is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    const webhookSecret = config.credentials['webhookSecret'];
    if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
      throw new AppError('Avito webhookSecret is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.webhookSecret = webhookSecret;
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.port = typeof config.credentials['port'] === 'number'
      ? config.credentials['port']
      : 3102;

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  // --- OAuth token management ---

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.accessToken;
    }

    if (this.tokenPromise) {
      return this.tokenPromise;
    }

    this.tokenPromise = (async () => {
      try {
        const body = JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'client_credentials',
        });

        const url = new URL(`${AVITO_API_BASE}/token`);

        const response = await this.httpPost(url, body, {
          'Content-Type': 'application/json',
        });

        if (!response.ok || !response.data?.['access_token']) {
          throw new AppError(
            `Avito OAuth failed: ${JSON.stringify(response.data)}`,
            401,
            'AUTH_FAILED',
          );
        }

        const expiresIn = typeof response.data['expires_in'] === 'number'
          ? response.data['expires_in'] * 1000
          : 86_400_000;

        this.tokenCache = {
          accessToken: response.data['access_token'] as string,
          expiresAt: Date.now() + expiresIn,
        };

        return this.tokenCache.accessToken;
      } finally {
        this.tokenPromise = null;
      }
    })();

    return this.tokenPromise;
  }

  // --- Inbound webhook handler ---

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const body = await this.readBody(req);

    // Signature verification
    const signature = req.headers['x-signature'] as string | undefined
      ?? req.headers['x-avito-signature'] as string | undefined;

    if (!signature || !verifyGenericWebhookSignature(body, signature, this.webhookSecret)) {
      logger.warn({ channelId: this.channelId }, 'Avito webhook signature verification failed');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_signature' }));
      return;
    }

    let payload: AvitoWebhookPayload;
    try {
      payload = JSON.parse(body) as AvitoWebhookPayload;
    } catch {
      res.writeHead(400).end();
      return;
    }

    // Respond 200 immediately — Avito requires <2s ack
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');

    // Process async after 200 response
    this.processWebhook(payload).catch((err) => {
      logger.error({ err, channelId: this.channelId }, 'Avito webhook processing error');
    });
  }

  private async processWebhook(payload: AvitoWebhookPayload): Promise<void> {
    const msg = payload.payload?.message;
    if (!msg || !msg.id) return;

    // Idempotency check — deduplicate webhook redeliveries
    const messageId = String(msg.id);
    if (this.isDuplicate(messageId)) {
      logger.debug({ messageId }, 'Avito duplicate webhook — skipping');
      return;
    }
    this.markSeen(messageId);

    // Skip own outbound messages (type = 'outgoing' or author is the bot)
    if (msg.type === 'outgoing') return;

    const attachments = extractAvitoAttachments(msg.attachments);

    const message: ChannelMessage = {
      id: messageId,
      channelId: this.channelId,
      externalUserId: String(msg.author_id ?? payload.payload?.user_id ?? ''),
      content: msg.body ?? '',
      timestamp: msg.created_at ? new Date(msg.created_at) : new Date(),
      metadata: {
        chatId: payload.payload?.chat_id,
        userId: payload.payload?.user_id,
      },
      ...(attachments.length > 0 && { attachments }),
    };

    const publishPayload: Record<string, string> = {
      channel_type: 'avito',
      channel_id: this.channelId,
      message_id: message.id,
      persona_slug: this.personaSlug,
      content: message.content,
      tenant_id: this.tenantId,
      external_user_id: message.externalUserId,
    };

    if (payload.payload?.chat_id != null) {
      publishPayload.avito_chat_id = String(payload.payload.chat_id);
    }

    if (attachments.length > 0) {
      publishPayload.attachments_json = JSON.stringify(attachments.map((a) => ({
        kind: a.kind,
        url: a.url,
        mime: a.mime,
        filename: a.filename,
      })));
    }

    await this.transport.publish(REDIS_STREAMS.INBOUND, publishPayload);

    if (this.incomingHandler) {
      await this.incomingHandler(message);
    }
  }

  // --- Idempotency (in-memory with TTL cleanup) ---

  private isDuplicate(messageId: string): boolean {
    return this.seenMessages.has(messageId);
  }

  private markSeen(messageId: string): void {
    this.seenMessages.set(messageId, Date.now());
  }

  private cleanupSeenMessages(): void {
    const ttl = 300_000; // 5 minutes
    const now = Date.now();
    for (const [id, ts] of this.seenMessages) {
      if (now - ts > ttl) {
        this.seenMessages.delete(id);
      }
    }
  }

  // --- Outbound consumer ---

  private startOutboundConsumer(): void {
    const consumerName = `avito-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-avito',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('avito', {
          content: msg.data.content ?? '',
        });
        if (!rateCheck.allowed) {
          logger.warn({ reason: rateCheck.reason, channelId: this.channelId }, 'Rate limit exceeded');
          return;
        }

        let attachments: import('@undrecreaitwins/shared').ChannelAttachment[] | undefined;
        if (msg.data.attachments_json) {
          try {
            attachments = JSON.parse(msg.data.attachments_json) as import('@undrecreaitwins/shared').ChannelAttachment[];
          } catch {
            logger.warn({ channelId: this.channelId }, 'Failed to parse attachments_json from outbound stream');
          }
        }

        await this.send({
          id: msg.data.message_id ?? '',
          channelId: this.channelId,
          externalUserId: msg.data.external_user_id ?? '',
          content: msg.data.content ?? '',
          timestamp: new Date(),
          metadata: {
            chatId: msg.data.avito_chat_id,
          },
          ...(attachments && attachments.length > 0 && { attachments }),
        });
      },
    ).catch(() => {
      this._status = 'error';
    });
  }

  // --- Send (outbound) ---

  async send(message: ChannelMessage): Promise<void> {
    const chatId = (message.metadata?.['chatId'] ?? message.externalUserId) as string;
    if (!chatId) {
      throw new AppError('Avito send requires chatId in metadata or externalUserId', 400, 'MISSING_CHAT_ID');
    }

    const token = await this.getAccessToken();

    // Avito attachments: send as text links (no native upload in messenger API)
    let content = message.content;
    if (message.attachments && message.attachments.length > 0) {
      const links = message.attachments
        .map((a) => a.url ?? `[${a.filename ?? a.kind}]`)
        .join('\n');
      content = content ? `${content}\n${links}` : links;
    }

    const payload = JSON.stringify({
      message: {
        type: 'text',
        body: content,
      },
    });

    const url = new URL(`${AVITO_API_BASE}/messenger/v1/messages/${chatId}`);

    try {
      const response = await this.httpPost(url, payload, {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Request-Id': randomUUID(),
      });

      if (!response.ok) {
        throw new AppError(
          `Avito send failed: ${JSON.stringify(response.data)}`,
          500,
          'SEND_FAILED',
        );
      }
    } catch (err) {
      if (err instanceof AppError) {
        // Invalidate token cache on auth errors — force re-auth next time
        if (err.code === 'AUTH_FAILED' || err.code === 'SEND_FAILED') {
          this.tokenCache = null;
        }
      }
      this._status = 'error';
      logger.error({ err, channelId: this.channelId, chatId }, 'Avito send failed');
      throw err;
    }
  }

  // --- HTTP helpers ---

  private httpPost(
    url: URL,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; data: Record<string, unknown>; statusCode: number }> {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            ...headers,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              data = { raw };
            }
            resolve({
              ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300,
              data,
              statusCode: res.statusCode ?? 500,
            });
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
      });
      req.write(body);
      req.end();
    });
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // --- Lifecycle ---

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.listen(this.port, () => {
        logger.info({ port: this.port, channelId: this.channelId }, 'Avito HTTP server listening');
        resolve();
      });
      this.server.on('error', reject);
    });

    // Start periodic cleanup of seen messages
    this.cleanupInterval = setInterval(() => this.cleanupSeenMessages(), 60_000);

    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Avito adapter connected');
  }

  async disconnect(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    await this.transport.disconnect();
    this.tokenCache = null;
    this.seenMessages.clear();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'Avito adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
    };
  }
}
