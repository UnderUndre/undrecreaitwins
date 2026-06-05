import { Redis } from 'ioredis';
import pino from 'pino';
import { ChannelTransport } from './channel-transport.js';
import { ChatService } from './chat-service.js';
import { AppError, REDIS_STREAMS, DEDUP_TTL_SECONDS } from '@undrecreaitwins/shared';
import { isRetryableProviderError, enqueueProviderRetry } from './retry/provider-retry.worker.js';

const logger = pino({ name: 'channel-orchestrator' });
const chatService = new ChatService();

const VALID_CHANNEL_TYPES = new Set(['telegram', 'whatsapp']);

function extractChannelType(raw: string | undefined): 'telegram' | 'whatsapp' {
  if (raw && VALID_CHANNEL_TYPES.has(raw)) return raw as 'telegram' | 'whatsapp';
  return 'telegram';
}

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
        const acquiredLock = await this.dedupRedis.set(dedupKey, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
        if (!acquiredLock) return;

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
        } catch (err) {
          if (isRetryableProviderError(err) && err instanceof AppError) {
            const conversationId = err.context.conversationId;
            const personaId = err.context.personaId;
            const channelType = extractChannelType(d['channel_type']);

            if (conversationId && personaId) {
              await enqueueProviderRetry({
                tenantId: tenant_id,
                personaId,
                personaSlug: persona_slug,
                conversationId,
                channelType,
                chatId: channel_id,
                peerId: external_user_id,
                originalMessageId: message_id,
                userMessage: content,
                systemPrompt: '',
                conversationHistory: [],
                budget: {
                  maxTokens: response_budget_maxTokens(content),
                },
                originalError: {
                  message: err.message,
                  code: err.code || 'unknown',
                },
                originalAttemptAt: new Date().toISOString(),
                sourcePath: 'prod',
              });

              return;
            }

            logger.warn(
              {
                errCode: err.code,
                hasConversationId: !!conversationId,
                hasPersonaId: !!personaId,
                channel_id,
                message_id,
              },
              'Retryable provider error skipped — missing conversationId/personaId context on error',
            );
          }

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

function response_budget_maxTokens(content: string): number {
  const estimated = Math.ceil(content.length * 1.5);
  return Math.max(estimated, 500);
}
