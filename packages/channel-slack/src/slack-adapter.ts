import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import pino from 'pino';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const logger = pino({ name: 'slack-adapter' });

export class SlackAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private botToken: string;
  private signingSecret: string;
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
    const botToken = config.credentials['botToken'];
    if (typeof botToken !== 'string' || botToken.length === 0) {
      throw new AppError('Slack botToken is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    const signingSecret = config.credentials['signingSecret'];
    if (typeof signingSecret !== 'string' || signingSecret.length === 0) {
      throw new AppError('Slack signingSecret is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    this.botToken = botToken;
    this.signingSecret = signingSecret;
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.port = typeof config.credentials['port'] === 'number'
      ? config.credentials['port']
      : 3100;

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const body = await this.readBody(req);

    // Slack URL verification challenge
    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];

    if (!this.verifySignature(body, timestamp as string | undefined, signature as string | undefined)) {
      logger.warn({ channelId: this.channelId }, 'Slack signature verification failed');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_signature' }));
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      res.writeHead(400).end();
      return;
    }

    // Handle URL verification challenge
    if (payload['type'] === 'url_verification' && typeof payload['challenge'] === 'string') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ challenge: payload['challenge'] }));
      return;
    }

    // Handle event callback
    if (payload['type'] === 'event_callback') {
      const event = payload['event'] as Record<string, unknown> | undefined;
      if (event && event['type'] === 'message') {
        // Ignore bot messages + unsupported subtypes (edits, deletes, joins) — gemini
        if (event['bot_id'] || event['subtype'] === 'bot_message' || (event['subtype'] && event['subtype'] !== 'file_share')) {
          res.writeHead(200).end();
          return;
        }

        const message: ChannelMessage = {
          id: event['event_ts'] as string ?? String(Date.now()),
          channelId: this.channelId,
          externalUserId: event['user'] as string ?? '',
          content: event['text'] as string ?? '',
          timestamp: new Date(parseFloat(event['ts'] as string ?? Date.now())),
          metadata: {
            channel: event['channel'],
            threadTs: event['thread_ts'],
          },
        };

        await this.transport.publish(REDIS_STREAMS.INBOUND, {
          channel_type: 'slack',
          channel_id: this.channelId,
          message_id: message.id,
          persona_slug: this.personaSlug,
          content: message.content,
          tenant_id: this.tenantId,
          external_user_id: (event['channel'] as string) ?? '',
        });

        if (this.incomingHandler) {
          await this.incomingHandler(message);
        }
      }

      res.writeHead(200).end();
      return;
    }

    res.writeHead(200).end();
  }

  private verifySignature(
    body: string,
    timestamp?: string,
    signature?: string,
  ): boolean {
    if (!timestamp || !signature) return false;

    // Reject requests older than 5 minutes
    const fiveMinutes = 300;
    const elapsed = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
    if (isNaN(elapsed) || elapsed > fiveMinutes) {
      return false;
    }

    const sigBasestring = `v0:${timestamp}:${body}`;
    const hash = createHmac('sha256', this.signingSecret).update(sigBasestring).digest('hex');
    const expected = `v0=${hash}`;

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
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
        logger.info({ port: this.port, channelId: this.channelId }, 'Slack HTTP server listening');
        resolve();
      });
      this.server.on('error', reject);
    });

    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Slack adapter connected');
  }

  private startOutboundConsumer(): void {
    const consumerName = `slack-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-slack',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('slack', {
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
          metadata: {
            channel: msg.data.slack_channel,
          },
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
    logger.info({ channelId: this.channelId }, 'Slack adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    const channel = (message.metadata?.['channel'] as string) ?? message.externalUserId;

    const payload = JSON.stringify({
      channel,
      text: message.content,
    });

    const url = new URL('https://slack.com/api/chat.postMessage');

    try {
      await new Promise<void>((resolve, reject) => {
        const mod = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = mod(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.botToken}`,
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString('utf8');
              try {
                const parsed = JSON.parse(body) as Record<string, unknown>;
                if (parsed['ok'] !== true) {
                  reject(new Error(`Slack API error: ${parsed['error'] ?? 'unknown'}`));
                } else {
                  resolve();
                }
              } catch {
                reject(new Error('Invalid JSON response from Slack API'));
              }
            });
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'Slack send failed');
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
