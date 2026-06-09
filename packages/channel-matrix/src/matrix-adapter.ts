import { MatrixClient, MemoryStorageProvider } from 'matrix-bot-sdk';
import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import pino from 'pino';

const logger = pino({ name: 'matrix-adapter' });

interface MatrixTimelineEvent {
  event_id: string;
  room_id: string;
  sender: string;
  type: string;
  content?: {
    msgtype?: string;
    body?: string;
    [key: string]: unknown;
  };
  unsigned?: Record<string, unknown>;
}

export class MatrixAdapter implements ChannelAdapter {
  private client: MatrixClient;
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private ownUserId?: string;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const homeserverUrl = config.credentials['homeserverUrl'];
    const accessToken = config.credentials['accessToken'];

    if (typeof homeserverUrl !== 'string' || homeserverUrl.length === 0) {
      throw new AppError('Matrix homeserverUrl is required in credentials', 400, 'INVALID_CREDENTIALS');
    }
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new AppError('Matrix accessToken is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    const storage = new MemoryStorageProvider();
    this.client = new MatrixClient(homeserverUrl, accessToken, storage);

    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.ownUserId = typeof config.credentials['userId'] === 'string'
      ? config.credentials['userId']
      : undefined;

    this.client.on('Room.timeline', (event: MatrixTimelineEvent) => {
      this.handleTimelineEvent(event).catch((err) => {
        logger.error({ err, eventId: event.event_id }, 'Error handling Matrix timeline event');
      });
    });

    this.client.on('error', (err: Error) => {
      logger.error({ err }, 'Matrix client error');
      this._status = 'error';
    });
  }

  private async handleTimelineEvent(event: MatrixTimelineEvent): Promise<void> {
    if (event.type !== 'm.room.message') return;

    const msgtype = event.content?.msgtype;
    if (msgtype !== 'm.text') return;

    // Ignore own messages (userId stored from constructor credentials)
    if (this.ownUserId && event.sender === this.ownUserId) return;

    const body = event.content?.body;
    if (typeof body !== 'string' || body.length === 0) return;

    const message: ChannelMessage = {
      id: event.event_id,
      channelId: this.channelId,
      externalUserId: event.sender,
      content: body,
      timestamp: new Date(),
      metadata: {
        roomId: event.room_id,
        eventId: event.event_id,
      },
    };

    const publishPayload: Record<string, string> = {
      channel_type: 'matrix',
      channel_id: this.channelId,
      message_id: message.id,
      persona_slug: this.personaSlug,
      content: message.content,
      tenant_id: this.tenantId,
      external_user_id: event.room_id as string,
    };

    await this.transport.publish(REDIS_STREAMS.INBOUND, publishPayload);

    if (this.incomingHandler) {
      await this.incomingHandler(message);
    }
  }

  async connect(): Promise<void> {
    this.client.start();
    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Matrix adapter connected');
  }

  private startOutboundConsumer(): void {
    const consumerName = `matrix-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-matrix',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('matrix', {
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
          metadata: msg.data.metadata ? JSON.parse(msg.data.metadata) : undefined,
        });
      },
    ).catch((err: Error) => {
      logger.error({ err, channelId: this.channelId }, 'Outbound consumer failed');
      this._status = 'error';
    });
  }

  async disconnect(): Promise<void> {
    this.client.stop();
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'Matrix adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    try {
      const roomId = message.metadata?.['roomId'] as string
        ?? message.externalUserId;

      if (!roomId) {
        logger.warn({ channelId: this.channelId }, 'No roomId or externalUserId for Matrix send');
        return;
      }

      await this.client.sendText(roomId, message.content);
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'Matrix send failed');
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
