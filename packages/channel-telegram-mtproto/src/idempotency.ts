import type { Redis } from 'ioredis';

export class IdempotencyStore {
  constructor(private readonly redis: Redis, private readonly channelId: string) {}

  async isDuplicate(externalMessageId: string): Promise<boolean> {
    const key = `mtproto:dedup:${this.channelId}:${externalMessageId}`;
    const result = await this.redis.set(key, '1', 'EX', 86400, 'NX');
    return result === null; // If result is null, the key already existed
  }
}
