import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import pino from 'pino';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const logger = pino({ name: 'mattermost-adapter' });

export class MattermostAdapter implements ChannelAdapter {
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private botToken: string;
  private serverUrl: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private ws: WebSocket | null = null;
  private lastPingAt?: Date;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const botToken = config.credentials['botToken'];
    if (typeof botToken !== 'string' || botToken.length === 0) {
      throw new AppError('Mattermost botToken is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    const serverUrl = config.credentials['serverUrl'];
    if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
      throw new AppError('Mattermost serverUrl is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    this.botToken = botToken;
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
  }

  async connect(): Promise<void> {
    await this.connectWebSocket();
    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Mattermost adapter connected');
  }

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.serverUrl.replace(/^http/, 'ws')}/api/v4/websocket`;
      this.ws = new WebSocket(wsUrl);

      this.ws.addEventListener('open', () => {
        logger.info({ channelId: this.channelId }, 'Mattermost WebSocket connected');
        // Send authentication message
        this.ws!.send(JSON.stringify({
          seq: 1,
          action: 'authentication_challenge',
          data: { token: this.botToken },
        }));
        resolve();
      });

      this.ws.addEventListener('message', (event: MessageEvent) => {
        this.handleWsMessage(event).catch((err) => {
          logger.error({ err }, 'Error handling Mattermost WebSocket message');
        });
      });

      this.ws.addEventListener('error', (event: Event) => {
        logger.error({ err: (event as ErrorEvent).message }, 'Mattermost WebSocket error');
        this._status = 'error';
        reject(new Error(`Mattermost WebSocket error: ${(event as ErrorEvent).message}`));
      });

      this.ws.addEventListener('close', () => {
        logger.info({ channelId: this.channelId }, 'Mattermost WebSocket closed');
        if (this._status === 'active') {
          this._status = 'disconnected';
        }
      });
    });
  }

  private async handleWsMessage(event: MessageEvent): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data as string) as Record<string, unknown>;
    } catch {
      return;
    }

    // Handle posted events
    if (data['event'] === 'posted') {
      const postData = data['data'] as Record<string, unknown> | undefined;
      if (!postData) return;

      const post = postData['post'] as string | undefined;
      if (!post) return;

      let parsedPost: Record<string, unknown>;
      try {
        parsedPost = JSON.parse(post) as Record<string, unknown>;
      } catch {
        return;
      }

      // Ignore bot messages
      const senderId = parsedPost['user_id'] as string | undefined;
      const botUserId = data['broadcast'] !== undefined
        ? (data['broadcast'] as Record<string, unknown>)['omit_users'] as string | undefined
        : undefined;
      if (senderId === botUserId) return;
      if (parsedPost['props'] !== undefined) {
        const props = parsedPost['props'] as Record<string, unknown>;
        if (props['from_bot'] === 'true') return;
      }

      const message: ChannelMessage = {
        id: parsedPost['id'] as string ?? String(Date.now()),
        channelId: this.channelId,
        externalUserId: senderId ?? '',
        content: parsedPost['message'] as string ?? '',
        timestamp: new Date((parsedPost['create_at'] as number) ?? Date.now()),
        metadata: {
          channelId: parsedPost['channel_id'],
          rootId: parsedPost['root_id'],
        },
      };

      this.lastPingAt = new Date();

      await this.transport.publish(REDIS_STREAMS.INBOUND, {
        channel_type: 'mattermost',
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
    }

    // Handle ping/pong for keepalive
    if (data['event'] === 'hello' || data['seq'] === undefined) {
      // Connection confirmed
      this.lastPingAt = new Date();
    }
  }

  private startOutboundConsumer(): void {
    const consumerName = `mattermost-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-mattermost',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('mattermost', {
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
            channelId: msg.data.mattermost_channel_id,
          },
        });
      },
    ).catch(() => {
      this._status = 'error';
    });
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'Mattermost adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    const channelId = (message.metadata?.['channelId'] as string) ?? '';

    const payload = JSON.stringify({
      channel_id: channelId,
      message: message.content,
    });

    const url = new URL(`${this.serverUrl}/api/v4/posts`);

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
              if (res.statusCode && res.statusCode >= 400) {
                const body = Buffer.concat(chunks).toString('utf8');
                reject(new Error(`Mattermost API error ${res.statusCode}: ${body}`));
              } else {
                resolve();
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
      logger.error({ err, channelId: this.channelId }, 'Mattermost send failed');
      throw err;
    }
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
      lastPingAt: this.lastPingAt,
    };
  }
}
