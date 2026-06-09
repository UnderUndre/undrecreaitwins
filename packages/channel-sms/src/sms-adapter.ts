import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import pino from 'pino';
import Twilio from 'twilio';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

const logger = pino({ name: 'sms-adapter' });

export class SmsAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private twilioClient: ReturnType<typeof Twilio>;
  private _authToken: string;
  private fromNumber: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private server: Server;
  private port: number;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const accountSid = config.credentials['accountSid'];
    if (typeof accountSid !== 'string' || accountSid.length === 0) {
      throw new AppError('SMS accountSid is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    const authToken = config.credentials['authToken'];
    if (typeof authToken !== 'string' || authToken.length === 0) {
      throw new AppError('SMS authToken is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    const fromNumber = config.credentials['fromNumber'];
    if (typeof fromNumber !== 'string' || fromNumber.length === 0) {
      throw new AppError('SMS fromNumber is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    this._authToken = authToken;
    this.fromNumber = fromNumber;
    this.twilioClient = Twilio(accountSid, authToken);
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.port = typeof config.credentials['port'] === 'number'
      ? config.credentials['port']
      : 3101;

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const body = await this.readBody(req);
    const twilioSignature = req.headers['x-twilio-signature'];

    if (!this.verifyTwilioSignature(req.url ?? '/', body, twilioSignature as string | undefined)) {
      logger.warn({ channelId: this.channelId }, 'Twilio signature verification failed');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_signature' }));
      return;
    }

    const params = new URLSearchParams(body);
    const messageBody = params.get('Body') ?? '';
    const from = params.get('From') ?? '';
    const messageSid = params.get('MessageSid') ?? '';

    if (!messageBody || !from) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing Body or From' }));
      return;
    }

    const message: ChannelMessage = {
      id: messageSid || `sms-${Date.now()}`,
      channelId: this.channelId,
      externalUserId: from,
      content: messageBody,
      timestamp: new Date(),
      metadata: {
        messageSid,
        from,
        to: params.get('To') ?? '',
      },
    };

    await this.transport.publish(REDIS_STREAMS.INBOUND, {
      channel_type: 'sms',
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

    // Twilio expects a valid TwiML response or empty 200
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end('<Response></Response>');
  }

  private verifyTwilioSignature(
    path: string,
    body: string,
    signature: string | undefined,
  ): boolean {
    if (!signature) return false;

    const url = `https://${path.replace(/^\//, '')}`;
    const params = Object.fromEntries(new URLSearchParams(body));
    return Twilio.validateRequest(this._authToken, signature, url, params);
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
        logger.info({ port: this.port, channelId: this.channelId }, 'SMS HTTP webhook server listening');
        resolve();
      });
      this.server.on('error', reject);
    });

    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'SMS adapter connected');
  }

  private startOutboundConsumer(): void {
    const consumerName = `sms-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-sms',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('sms', {
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
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'SMS adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    try {
      await this.twilioClient.messages.create({
        to: message.externalUserId,
        from: this.fromNumber,
        body: message.content,
      });
      logger.info({ to: message.externalUserId, channelId: this.channelId }, 'SMS sent');
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'SMS send failed');
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
