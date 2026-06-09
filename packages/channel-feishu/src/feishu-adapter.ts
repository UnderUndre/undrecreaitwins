import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import { verifyFeishuSignature } from '@undrecreaitwins/core/services/webhook-signature.js';
import { Redis } from 'ioredis';
import pino from 'pino';

const logger = pino({ name: 'feishu-adapter' });

const IDEMPOTENCY_TTL_SECONDS = 300;

interface FeishuCredentials {
  verificationToken: string;
  encryptKey: string;
  botToken?: string;
}

interface FeishuConfig {
  channelId: string;
  tenantId: string;
  personaSlug: string;
  redisUrl?: string;
  port?: number;
  credentials: FeishuCredentials;
}

interface FeishuEvent {
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
    create_time?: string;
  };
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
      };
    };
    message?: {
      message_id?: string;
      chat_id?: string;
      content?: string;
      msg_type?: string;
    };
  };
  challenge?: string;
  token?: string;
}

function extractTextContent(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as { text?: string };
    return parsed.text ?? rawContent;
  } catch {
    return rawContent;
  }
}

export class FeishuAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private idempotencyRedis: Redis;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private credentials: FeishuCredentials;
  private port: number;
  private _status: ChannelStatus = 'disconnected';
  private server: Server | null = null;
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;

  constructor(config: FeishuConfig) {
    if (!config.credentials?.verificationToken) {
      throw new AppError('Feishu verificationToken is required', 400, 'INVALID_CREDENTIALS');
    }
    if (!config.credentials?.encryptKey) {
      throw new AppError('Feishu encryptKey is required', 400, 'INVALID_CREDENTIALS');
    }

    this.transport = new ChannelTransport(config.redisUrl);
    this.idempotencyRedis = new Redis(config.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.credentials = config.credentials;
    this.port = config.port ?? 3000;
  }

  async connect(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, () => {
        logger.info({ port: this.port, channelId: this.channelId }, 'Feishu webhook server listening');
        resolve();
      });
      this.server!.on('error', (err) => {
        reject(err);
      });
    });

    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Feishu adapter connected');
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const body = await this.readBody(req);
    const timestamp = req.headers['x-lark-request-timestamp'] as string | undefined;
    const nonce = req.headers['x-lark-request-nonce'] as string | undefined;
    const signature = req.headers['x-lark-signature'] as string | undefined;

    // Handle URL verification challenge
    let parsed: FeishuEvent;
    try {
      parsed = JSON.parse(body) as FeishuEvent;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (parsed.challenge !== undefined && parsed.token === this.credentials.verificationToken) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ challenge: parsed.challenge }));
      return;
    }

    // Signature verification — MUST happen before any publish
    if (!timestamp || !nonce || !signature) {
      logger.warn({ channelId: this.channelId }, 'Missing signature headers from Feishu webhook');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing signature headers' }));
      return;
    }

    const valid = verifyFeishuSignature(timestamp, nonce, body, signature, this.credentials.encryptKey);
    if (!valid) {
      logger.warn({ channelId: this.channelId }, 'Invalid Feishu webhook signature');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }

    // Extract event data
    const eventId = parsed.header?.event_id ?? '';
    const senderOpenId = parsed.event?.sender?.sender_id?.open_id ?? '';
    const message = parsed.event?.message;
    const messageId = message?.message_id ?? eventId;
    const chatId = message?.chat_id ?? '';
    const rawContent = message?.content ?? '';
    const msgType = message?.msg_type ?? 'text';
    const content = msgType === 'text' ? extractTextContent(rawContent) : rawContent;

    if (!messageId || !senderOpenId) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Idempotency check
    const seenKey = `seen:feishu:${messageId}`;
    const set = await this.idempotencyRedis.set(seenKey, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    if (set !== 'OK') {
      logger.info({ messageId }, 'Duplicate Feishu message — already processed');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Publish to INBOUND stream
    const channelMessage: ChannelMessage = {
      id: messageId,
      channelId: this.channelId,
      externalUserId: senderOpenId,
      content,
      timestamp: new Date(),
      metadata: {
        chatId,
        eventId,
        msgType,
        tenantId: this.tenantId,
      },
    };

    await this.transport.publish(REDIS_STREAMS.INBOUND, {
      channel_type: 'feishu',
      channel_id: this.channelId,
      message_id: messageId,
      persona_slug: this.personaSlug,
      content,
      tenant_id: this.tenantId,
      external_user_id: senderOpenId,
    });

    if (this.incomingHandler) {
      await this.incomingHandler(channelMessage);
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

  private startOutboundConsumer(): void {
    const consumerName = `feishu-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-feishu',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('feishu', {
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
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    await this.idempotencyRedis.quit();
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'Feishu adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    const botToken = this.credentials.botToken;
    if (!botToken) {
      logger.warn({ channelId: this.channelId }, 'No Feishu bot token configured for sending');
      return;
    }

    const chatId = message.metadata?.['chatId'] as string ?? message.externalUserId;

    try {
      const body = JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: message.content }),
      });

      const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${botToken}`,
        },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Feishu API error ${response.status}: ${errorText}`);
      }
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'Feishu send failed');
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
