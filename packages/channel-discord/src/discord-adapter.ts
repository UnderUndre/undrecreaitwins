import { Client, GatewayIntentBits, type Message, type OmitPartialGroupDMChannel } from 'discord.js';
import type { ChannelAdapter, ChannelMessage, ChannelHealth, ChannelStatus, ChannelAttachment } from '@undrecreaitwins/shared';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChannelTransport, type StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import { channelRateLimiter } from '@undrecreaitwins/core/services/channel-rate-limiter.js';
import pino from 'pino';

const logger = pino({ name: 'discord-adapter' });

function classifyAttachmentMime(contentType: string | undefined): string {
  if (!contentType) return 'application/octet-stream';
  return contentType;
}

function classifyAttachmentKind(contentType: string | undefined): ChannelAttachment['kind'] {
  if (!contentType) return 'file';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  return 'file';
}

function extractAttachments(msg: OmitPartialGroupDMChannel<Message>): ChannelAttachment[] {
  if (!msg.attachments || msg.attachments.size === 0) return [];
  const attachments: ChannelAttachment[] = [];
  for (const [, attachment] of msg.attachments) {
    const mime = classifyAttachmentMime(attachment.contentType ?? undefined);
    attachments.push({
      kind: classifyAttachmentKind(attachment.contentType ?? undefined),
      url: attachment.url,
      mime,
      filename: attachment.name ?? undefined,
    });
  }
  return attachments;
}

export class DiscordAdapter implements ChannelAdapter {
  private client: Client;
  private transport: ChannelTransport;
  private channelId: string;
  private tenantId: string;
  private personaSlug: string;
  private _status: ChannelStatus = 'disconnected';
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;

  constructor(config: {
    channelId: string;
    tenantId: string;
    personaSlug: string;
    redisUrl?: string;
    credentials: Record<string, unknown>;
  }) {
    const botToken = config.credentials['botToken'];
    if (typeof botToken !== 'string' || botToken.length === 0) {
      throw new AppError('Discord botToken is required in credentials', 400, 'INVALID_CREDENTIALS');
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.transport = new ChannelTransport(config.redisUrl);
    this.channelId = config.channelId;
    this.tenantId = config.tenantId;
    this.personaSlug = config.personaSlug;

    this.client.on('messageCreate', (msg) => this.handleMessage(msg));
    this.client.on('error', (err) => {
      logger.error({ err }, 'Discord client error');
      this._status = 'error';
    });
  }

  private async handleMessage(msg: OmitPartialGroupDMChannel<Message>): Promise<void> {
    if (msg.author.bot) return;

    const attachments = extractAttachments(msg);

    const message: ChannelMessage = {
      id: msg.id,
      channelId: this.channelId,
      externalUserId: msg.author.id,
      content: msg.content,
      timestamp: new Date(msg.createdTimestamp),
      metadata: {
        channelId: msg.channelId,
        guildId: msg.guildId ?? undefined,
        isDM: msg.guildId === null,
      },
      ...(attachments.length > 0 && { attachments }),
    };

    const publishPayload: Record<string, string> = {
      channel_type: 'discord',
      channel_id: this.channelId,
      message_id: message.id,
      persona_slug: this.personaSlug,
      content: message.content,
      tenant_id: this.tenantId,
      external_user_id: msg.channelId,
    };

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

  async connect(): Promise<void> {
    const botToken = this.client.token ?? process.env.DISCORD_TOKEN;
    if (!botToken) {
      throw new AppError('Discord botToken not found', 400, 'INVALID_CREDENTIALS');
    }

    await this.client.login(botToken);
    this.startOutboundConsumer();
    this._status = 'active';
    logger.info({ channelId: this.channelId, tenantId: this.tenantId }, 'Discord adapter connected');
  }

  private startOutboundConsumer(): void {
    const consumerName = `discord-${this.channelId}`;
    this.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-discord',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.channelId) return;

        const rateCheck = channelRateLimiter.check('discord', {
          content: msg.data.content ?? '',
        });
        if (!rateCheck.allowed) {
          logger.warn({ reason: rateCheck.reason, channelId: this.channelId }, 'Rate limit exceeded');
          return;
        }

        let attachments: ChannelAttachment[] | undefined;
        if (msg.data.attachments_json) {
          try {
            attachments = JSON.parse(msg.data.attachments_json);
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
          ...(attachments && attachments.length > 0 && { attachments }),
        });
      },
    ).catch(() => {
      this._status = 'error';
    });
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
    await this.transport.disconnect();
    this._status = 'disconnected';
    logger.info({ channelId: this.channelId }, 'Discord adapter disconnected');
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    try {
      const channel = await this.client.channels.fetch((message.metadata?.['channelId'] as string) ?? message.externalUserId);
      if (!channel?.isSendable()) {
        logger.warn({ externalUserId: message.externalUserId }, 'Discord channel not found or not sendable');
        return;
      }

      if (message.attachments && message.attachments.length > 0) {
        const files = await this.resolveFiles(message.attachments);
        if (files.length > 0) {
          await channel.send({ content: message.content, files });
          return;
        }
        logger.warn({ channelId: this.channelId }, 'All attachment resolutions failed, falling back to text-only send');
      }

      await channel.send(message.content);
    } catch (err) {
      this._status = 'error';
      logger.error({ err, channelId: this.channelId }, 'Discord send failed');
      throw err;
    }
  }

  private async resolveFiles(
    attachments: ChannelAttachment[],
  ): Promise<Array<{ attachment: Buffer | string; name?: string }>> {
    const files: Array<{ attachment: Buffer | string; name?: string }> = [];
    for (const att of attachments) {
      try {
        if (att.bytes) {
          files.push({ attachment: att.bytes, name: att.filename });
        } else if (att.url) {
          files.push({ attachment: att.url, name: att.filename });
        }
      } catch (err) {
        logger.warn({ err, filename: att.filename }, 'Failed to resolve attachment, skipping');
      }
    }
    return files;
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this._status,
      uptimeSeconds: process.uptime(),
      lastPingAt: this.client.ws.ping > 0 ? new Date(Date.now() - this.client.ws.ping) : undefined,
    };
  }
}
