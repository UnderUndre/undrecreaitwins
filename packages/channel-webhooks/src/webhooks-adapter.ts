import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import { verifyGenericWebhookSignature } from '@undrecreaitwins/core/services/webhook-signature.js';
import pino from 'pino';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const logger = pino({ name: 'webhooks-adapter' });

const IDEMPOTENCY_TTL_SECONDS = 300;

export class WebhooksAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private webhookSecret: string;
  private outgoingUrl?: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private server: Server;
  private port: number;
  private redis: Redis;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const webhookSecret = config.credentials['webhookSecret'];
    if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) {
      throw new AppError('Webhooks webhookSecret is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    this.webhookSecret = webhookSecret;
    this.outgoingUrl = typeof config.credentials['outgoingUrl'] === 'string'
      ? config.credentials['outgoingUrl']
      : undefined;
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.port = typeof config.credentials['port'] === 'number'
      ? config.credentials['port']
      : 3102;
    this.redis = new Redis(config.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const body = await this.readBody(req);
    const signature = req.headers['x-webhook-signature'];

    if (!verifyGenericWebhookSignature(body, signature as string | undefined ?? '', this.webhookSecret)) {
      logger.warn({ channelId: this.channelId }, 'Webhook signature verification failed');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_signature' }));
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      logger.warn({ channelId: this.channelId }, 'Invalid JSON body in webhook request');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      return;
    }

    const content = typeof payload['text'] === 'string'
      ? payload['text']
      : typeof payload['content'] === 'string'
        ? payload['content']
        : '';
    const sender = typeof payload['sender'] === 'string'
      ? payload['sender']
      : typeof payload['from'] === 'string'
        ? payload['from']
        : '';
    const messageId = typeof payload['id'] === 'string'
      ? payload['id']
      : typeof payload['message_id'] === 'string'
        ? payload['message_id']
        : `webhook-${Date.now()}`;

    if (!content) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing text or content field' }));
      return;
    }

    // Idempotency check
    const seenKey = `seen:webhooks:${this.channelId}:${messageId}`;
    const isNew = await this.redis.set(seenKey, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    if (isNew !== 'OK') {
      logger.debug({ messageId, channelId: this.channelId }, 'Duplicate webhook message ignored');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'duplicate' }));
      return;
    }

    const message: ChannelMessage = {
      id: messageId,
      channelId: this.channelId,
      externalUserId: sender,
      content,
      timestamp: new Date(),
      metadata: {
        rawPayload: payload,
      },
    };

    await this.transport.publish(REDIS_STREAMS.INBOUND, {
      channel_type: 'webhook',
      channel_id: this.channelId,
      message_id: message.id,
      persona_slug: this.personaSlug,
      content: message.content,
      tenant_id: this.tenantId,
      external_user_id: message.externalUserId,
    });

    if (this.incomingHandler) {
      await this.incomingHandler(message);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.listen(this.port, () => {
        logger.info({ port: this.port, channelId: this.channelId }, 'Webhooks HTTP server listening');
        resolve();
      });
      this.server.on('error', reject);
    });

    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Webhooks adapter connected');
  }

  private startOutboundConsumer(): void {
    const consumerName = `webhooks-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-webhooks',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('webhook', {
          content: msg.data.content ?? '',
        });
        if (!rateCheck.allowed) {
          logger.warn({ reason: rateCheck.reason, channelId: this.channelId }, 'Rate limit exceeded');
          return;
        }

        await this.send({
          id: msg.data.message_id ?? '',
          channelId: this.channelId,
          externalUserId: msg.data.external_user_id ?? '',
          content: msg.data.content ?? '',
          timestamp: new Date(),
        });
      },
    ).catch(() => {
      this._status = 'error';
    });
  }

  async disconnect(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    await this.redis.quit();
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'Webhooks adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    if (!this.outgoingUrl) {
      logger.warn({ channelId: this.channelId }, 'No outgoingUrl configured, cannot send outbound webhook');
      return;
    }

    const payload = JSON.stringify({
      content: message.content,
      external_user_id: message.externalUserId,
      message_id: message.id,
    });

    const signature = `sha256=${createHmac('sha256', this.webhookSecret).update(payload).digest('hex')}`;

    try {
      const url = new URL(this.outgoingUrl);
      await new Promise<void>((resolve, reject) => {
        const mod = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = mod(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Signature': signature,
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve();
              } else {
                const responseBody = Buffer.concat(chunks).toString('utf8');
                reject(new Error(`Outgoing webhook failed with status ${res.statusCode}: ${responseBody}`));
              }
            });
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      logger.info({ outgoingUrl: this.outgoingUrl, channelId: this.channelId }, 'Outgoing webhook sent');
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'Outgoing webhook send failed');
      throw err;
    }
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
    };
  }
}
