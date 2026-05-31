import { NewMessage } from 'telegram/events/index.js';
import { Api } from 'telegram';
import type { ChannelAdapter, ChannelMessage, ChannelHealth } from '@undrecreaitwins/shared';
import { REDIS_STREAMS } from '@undrecreaitwins/shared';
import type { StreamMessage } from '@undrecreaitwins/core/services/channel-transport.js';
import type { MtprotoAdapterOptions } from './types.js';
import { MtprotoClient } from './client.js';
import { EligibilityFilter } from './eligibility.js';
import { RateLimiter } from './rate-limit.js';
import { IdempotencyStore } from './idempotency.js';

export class TelegramMtprotoAdapter implements ChannelAdapter {
  private readonly client: MtprotoClient;
  private readonly eligibility: EligibilityFilter;
  private readonly rateLimiter: RateLimiter;
  private readonly idempotency?: IdempotencyStore;
  private incomingHandler?: (message: ChannelMessage) => Promise<void>;
  private isConnected = false;
  private typingTimers: Map<string, NodeJS.Timeout> = new Map();
  private typingTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor(private readonly opts: MtprotoAdapterOptions) {
    this.client = new MtprotoClient(this.opts);
    this.eligibility = new EligibilityFilter(this.opts.allowlist);
    this.rateLimiter = new RateLimiter();
    if (this.opts.redis) {
      this.idempotency = new IdempotencyStore(this.opts.redis, this.opts.channelId);
    }
  }

  async connect(): Promise<void> {
    const tgClient = await this.client.connect();
    
    tgClient.addEventHandler(async (event: any) => {
      const message = event.message as Api.Message;
      if (!message) return;

      // Deduplicate messages on reconnect
      if (this.idempotency && await this.idempotency.isDuplicate(message.id.toString())) return;

      if (!this.eligibility.isEligible(message)) return;

      const peerId = this.eligibility.normalizePeerId(message.peerId);
      
      const channelMessage: ChannelMessage = {
        id: message.id.toString(),
        channelId: this.opts.channelId,
        externalUserId: peerId,
        content: message.message || '',
        timestamp: new Date(message.date * 1000),
        metadata: {
          chatId: peerId,
          isOutgoing: message.out,
          peerType: message.peerId ? message.peerId.constructor.name : 'unknown',
        }
      };

      this.startTyping(peerId);

      await this.opts.transport.publish(REDIS_STREAMS.INBOUND, {
        channel_id: this.opts.channelId,
        message_id: channelMessage.id,
        content: channelMessage.content,
        external_user_id: channelMessage.externalUserId,
      });

      if (this.incomingHandler) {
        await this.incomingHandler(channelMessage);
      }
    }, new NewMessage({}));

    this.startOutboundConsumer();
    this.isConnected = true;
  }

  private startOutboundConsumer(): void {
    const consumerName = `mtproto-${this.opts.channelId}`;
    this.opts.transport.consume(
      REDIS_STREAMS.OUTBOUND,
      'channel-telegram-mtproto',
      consumerName,
      async (msg: StreamMessage) => {
        if (msg.data.channel_id !== this.opts.channelId) return;
        await this.send({
          id: msg.data.message_id ?? '',
          channelId: this.opts.channelId,
          externalUserId: msg.data.external_user_id ?? '',
          content: msg.data.content ?? '',
          timestamp: new Date(),
        });
      }
    ).catch((err) => {
      console.error('Outbound consumer error:', err);
    });
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    for (const timer of this.typingTimers.values()) {
      clearInterval(timer);
    }
    this.typingTimers.clear();
    for (const timeout of this.typingTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.typingTimeouts.clear();
    this.isConnected = false;
  }

  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void {
    this.incomingHandler = handler;
  }

  async send(message: ChannelMessage): Promise<void> {
    const tgClient = this.client.getClient();
    this.stopTyping(message.externalUserId);

    await this.rateLimiter.executeWithRetry(message.externalUserId, async () => {
      await tgClient.sendMessage(message.externalUserId, {
        message: message.content,
      });
    });
  }

  private startTyping(peerId: string): void {
    if (this.typingTimers.has(peerId)) return;

    const refreshTyping = async () => {
      try {
        const tgClient = this.client.getClient();
        await tgClient.invoke(new Api.messages.SetTyping({
          peer: peerId,
          action: new Api.SendMessageTypingAction(),
        }));
      } catch (err) {
        console.error('Typing indicator error:', err);
      }
    };

    refreshTyping();
    const timer = setInterval(refreshTyping, this.opts.typingIntervalMs || 4000);
    this.typingTimers.set(peerId, timer);
    // Auto-stop typing after 30s to prevent indefinite interval
    const timeout = setTimeout(() => this.stopTyping(peerId), 30000);
    this.typingTimeouts.set(peerId, timeout);
  }

  private stopTyping(peerId: string): void {
    const timer = this.typingTimers.get(peerId);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(peerId);
    }
    const timeout = this.typingTimeouts.get(peerId);
    if (timeout) {
      clearTimeout(timeout);
      this.typingTimeouts.delete(peerId);
    }
  }

  async health(): Promise<ChannelHealth> {
    return {
      status: this.isConnected ? 'active' : 'disconnected',
      uptimeSeconds: process.uptime(),
    };
  }
}
