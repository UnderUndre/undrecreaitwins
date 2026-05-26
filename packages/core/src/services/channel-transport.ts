import { Redis } from 'ioredis';

export interface StreamMessage {
  id: string;
  data: Record<string, string>;
}

export class ChannelTransport {
  private redis: Redis;

  constructor(redisUrl?: string) {
    this.redis = new Redis(redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
  }

  async publish(stream: string, payload: Record<string, string>): Promise<string> {
    const entries: string[] = [];
    for (const [k, v] of Object.entries(payload)) {
      entries.push(k, v);
    }
    const result = await this.redis.xadd(stream, '*', ...entries);
    return result!;
  }

  async consume(
    stream: string,
    group: string,
    consumer: string,
    handler: (message: StreamMessage) => Promise<void>,
    count = 10,
    blockMs = 5000,
  ): Promise<void> {
    await this.ensureGroup(stream, group);

    while (true) {
      const results = await this.redis.xreadgroup(
        'GROUP', group, consumer,
        'COUNT', count,
        'BLOCK', blockMs,
        'STREAMS', stream,
        '>',
      );

      if (!results) continue;

      for (const [, messages] of results as [string, [string, Record<string, string>][]][]) {
        for (const [id, data] of messages) {
          try {
            await handler({ id, data });
            await this.redis.xack(stream, group, id);
          } catch {
            // not acked → redelivered
          }
        }
      }
    }
  }

  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) {
        throw err;
      }
    }
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
