import { Telegraf, type Context } from 'telegraf';
import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus } from '@undrecreaitwins/shared';
import { REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';

export class TelegramAdapter implements ChannelAdapter {
  private bot: Telegraf;
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;

  constructor(config: {
    botToken: string;
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
  }) {
    this.bot = new Telegraf(config.botToken);
    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.bot.on('text', async (ctx: Context) => {
      if (!ctx.message || !ctx.from?.id) return;
      const text = 'text' in ctx.message ? ctx.message.text : undefined;
      if (!text) return;

      const message: ChannelMessage = {
        id: ctx.message.message_id.toString(),
        channelId: this.channelId,
        externalUserId: ctx.from.id.toString(),
        content: text,
        timestamp: new Date(ctx.message.date * 1000),
      };

      await this.transport.publish(REDIS_STREAMS.INBOUND, {
        channel_type: 'telegram',
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
    });
  }

  async connect(): Promise<void> {
    this.startOutboundConsumer();
    await this.bot.launch();
    this._status = 'active';
  }

  private startOutboundConsumer(): void {
    const consumerName = `telegram-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-telegram',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;
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
    this.bot.stop();
    await this.transport.disconnect();
    this._status = 'disconnected';
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(
        message.externalUserId,
        message.content,
      );
    } catch (error) {
      this._status = 'error';
      throw error;
    }
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
    };
  }
}
