import pino from 'pino';

const logger = pino({ name: 'channel-rate-limiter' });

export interface PlatformLimits {
  maxMessagesPerSecond: number;
  maxMessageLength: number;
  maxMediaSizeBytes: number;
}

const PLATFORM_LIMITS: Record<string, PlatformLimits> = {
  telegram: { maxMessagesPerSecond: 30, maxMessageLength: 4096, maxMediaSizeBytes: 50 * 1024 * 1024 },
  whatsapp_evolution: { maxMessagesPerSecond: 5, maxMessageLength: 65536, maxMediaSizeBytes: 64 * 1024 * 1024 },
  discord: { maxMessagesPerSecond: 5, maxMessageLength: 2000, maxMediaSizeBytes: 25 * 1024 * 1024 },
  slack: { maxMessagesPerSecond: 1, maxMessageLength: 40000, maxMediaSizeBytes: 1 * 1024 * 1024 },
  mattermost: { maxMessagesPerSecond: 10, maxMessageLength: 16383, maxMediaSizeBytes: 50 * 1024 * 1024 },
  dingtalk: { maxMessagesPerSecond: 5, maxMessageLength: 20000, maxMediaSizeBytes: 20 * 1024 * 1024 },
  feishu: { maxMessagesPerSecond: 5, maxMessageLength: 4096, maxMediaSizeBytes: 30 * 1024 * 1024 },
  wecom: { maxMessagesPerSecond: 5, maxMessageLength: 2048, maxMediaSizeBytes: 20 * 1024 * 1024 },
  matrix: { maxMessagesPerSecond: 10, maxMessageLength: 65536, maxMediaSizeBytes: 100 * 1024 * 1024 },
  email: { maxMessagesPerSecond: 1, maxMessageLength: 1000000, maxMediaSizeBytes: 25 * 1024 * 1024 },
  sms: { maxMessagesPerSecond: 1, maxMessageLength: 1600, maxMediaSizeBytes: 0 },
  webhook: { maxMessagesPerSecond: 100, maxMessageLength: 1000000, maxMediaSizeBytes: 100 * 1024 * 1024 },
  homeassistant: { maxMessagesPerSecond: 10, maxMessageLength: 50000, maxMediaSizeBytes: 10 * 1024 * 1024 },
  vk: { maxMessagesPerSecond: 3, maxMessageLength: 4096, maxMediaSizeBytes: 50 * 1024 * 1024 },
  avito: { maxMessagesPerSecond: 1, maxMessageLength: 10000, maxMediaSizeBytes: 10 * 1024 * 1024 },
};

const DEFAULT_LIMITS: PlatformLimits = { maxMessagesPerSecond: 100, maxMessageLength: 1000000, maxMediaSizeBytes: 100 * 1024 * 1024 };

export class ChannelRateLimiter {
  private counters: Map<string, { count: number; resetAt: number }> = new Map();

  getLimits(channelType: string): PlatformLimits {
    return PLATFORM_LIMITS[channelType] ?? DEFAULT_LIMITS;
  }

  check(
    channelType: string,
    payload: { content: string; mediaSizeBytes?: number },
  ): { allowed: boolean; reason?: string } {
    const limits = this.getLimits(channelType);

    if (payload.content.length > limits.maxMessageLength) {
      logger.warn({ channelType, reason: 'message_too_long', length: payload.content.length, max: limits.maxMessageLength });
      return { allowed: false, reason: 'message_too_long' };
    }

    if (payload.mediaSizeBytes !== undefined && payload.mediaSizeBytes > limits.maxMediaSizeBytes) {
      logger.warn({ channelType, reason: 'media_too_large', size: payload.mediaSizeBytes, max: limits.maxMediaSizeBytes });
      return { allowed: false, reason: 'media_too_large' };
    }

    const now = Date.now();
    const counter = this.counters.get(channelType);

    if (counter && counter.resetAt > now) {
      counter.count += 1;
      if (counter.count > limits.maxMessagesPerSecond) {
        logger.warn({ channelType, reason: 'rate_exceeded', count: counter.count, max: limits.maxMessagesPerSecond });
        return { allowed: false, reason: 'rate_exceeded' };
      }
    } else {
      this.counters.set(channelType, { count: 1, resetAt: now + 1000 });
    }

    return { allowed: true };
  }

  reset(channelType: string): void {
    this.counters.delete(channelType);
  }
}

export const channelRateLimiter = new ChannelRateLimiter();
