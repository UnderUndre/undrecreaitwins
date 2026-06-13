import { Redis } from 'ioredis';
import pino from 'pino';
import { ChannelTransport } from './channel-transport.js';
import { ChatService } from './chat-service.js';
import { AppError, REDIS_STREAMS, DEDUP_TTL_SECONDS } from '@undrecreaitwins/shared';
import { isRetryableProviderError, enqueueProviderRetry } from './retry/provider-retry.worker.js';

const logger = pino({ name: 'channel-orchestrator' });
const chatService = new ChatService();

const VALID_CHANNEL_TYPES = new Set<string>([
  'telegram', 'whatsapp_evolution', 'discord', 'slack', 'mattermost',
  'dingtalk', 'feishu', 'wecom', 'matrix', 'email', 'sms', 'webhook', 'homeassistant',
  'vk', 'avito',
]);

function extractChannelType(raw: string | undefined): string {
  if (raw && VALID_CHANNEL_TYPES.has(raw)) return raw;
  return 'telegram';
}

export class ChannelOrchestrator {
  private transport: ChannelTransport;
  private dedupRedis: Redis;

  constructor(redisUrl?: string) {
    this.transport = new ChannelTransport(redisUrl);
    this.dedupRedis = new Redis(redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
  }

  private assertNotStreaming(payload: Record<string, string>): void {
    if ('stream' in payload || 'partial' in payload) {
      logger.error(
        { channel_id: payload['channel_id'], message_id: payload['message_id'] },
        'CL-A7 guard: OUTBOUND payload contains stream/partial flag — discarded',
      );
      throw new AppError('OUTBOUND must not contain stream/partial flags', 500, 'STREAMING_OUTBOUND_BLOCKED');
    }
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
            channelContext: {
              channelMessageId: message_id,
              chatId: channel_id,
              peerId: external_user_id,
            },
          });

          // Channel conversations: answer is already delivered via CAS in ChatService.
          // Return the response for caller compatibility (logging/metrics).
          if (response.metadata?.degraded_mode) {
            logger.info({ channel_id, message_id }, 'Response delivered via fallback path');
          }
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
                  maxTokens: undefined,
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

          const errPayload: Record<string, string> = {
            channel_id,
            message_id,
            reply_to: message_id,
            error: 'processing_failed',
            tenant_id,
          };
          this.assertNotStreaming(errPayload);
          await this.transport.publish(REDIS_STREAMS.OUTBOUND, errPayload);
        }
      },
    );
  }

  async stop(): Promise<void> {
    await this.transport.disconnect();
    await this.dedupRedis.quit();
  }
}
