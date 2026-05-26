import { Redis } from 'ioredis';
import { ChannelTransport } from './channel-transport.js';
import { ChatService } from './chat-service.js';
import { REDIS_STREAMS, DEDUP_TTL_SECONDS } from '@undrecreaitwins/shared';

const chatService = new ChatService();

export class ChannelOrchestrator {
  private transport: ChannelTransport;
  private dedupRedis: Redis;

  constructor(redisUrl?: string) {
    this.transport = new ChannelTransport(redisUrl);
    this.dedupRedis = new Redis(redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
  }

  async start(consumerName: string): Promise<void> {
    await this.transport.consume(
      REDIS_STREAMS.INBOUND,
      'twin-orchestrator',
      consumerName,
      async (message) => {
        const d = message.data;
        const channel_id = d['channel_id'] ?? '';
        const message_id = d['message_id'] ?? '';
        const persona_slug = d['persona_slug'] ?? '';
        const content = d['content'] ?? '';
        const tenant_id = d['tenant_id'] ?? '';
        const external_user_id = d['external_user_id'] ?? '';

        const dedupKey = `dedup:${channel_id}:${message_id}`;
        const isDuplicate = await this.dedupRedis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
        if (!isDuplicate) return;

        try {
          const response = await chatService.complete({
            tenantId: tenant_id,
            personaSlug: persona_slug,
            messages: [{ role: 'user', content }],
          });

          const replyContent = response.choices[0]?.message?.content ?? '';
          await this.transport.publish(REDIS_STREAMS.OUTBOUND, {
            channel_id,
            message_id,
            reply_to: message_id,
            content: replyContent,
            tenant_id,
            external_user_id,
          });
        } catch {
          await this.transport.publish(REDIS_STREAMS.OUTBOUND, {
            channel_id,
            message_id,
            reply_to: message_id,
            error: 'processing_failed',
            tenant_id,
          });
        }
      },
    );
  }

  async stop(): Promise<void> {
    await this.transport.disconnect();
    await this.dedupRedis.quit();
  }
}
