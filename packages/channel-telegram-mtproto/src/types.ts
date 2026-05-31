import type { ChannelTransport } from '@undrecreaitwins/core/services/channel-transport.js';
import type { Redis } from 'ioredis';

export interface SecretResolver {
  getApiHash(channelId: string): Promise<string>;
  getSessionString(channelId: string): Promise<string>;
}

export interface AllowlistConfig {
  chats?: string[];
  senders?: string[];
}

export interface MtprotoAdapterOptions {
  channelId: string;
  apiId: number;
  secrets: SecretResolver;
  transport: ChannelTransport;
  allowlist?: AllowlistConfig;
  typingIntervalMs?: number;
  redis?: Redis;
}

export class InvalidSessionError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'InvalidSessionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
