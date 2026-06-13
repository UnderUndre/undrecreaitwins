import { Worker, Queue, type Job } from 'bullmq';
import { eq, and, lte } from 'drizzle-orm';
import { REDIS_STREAMS } from '@undrecreaitwins/shared';
import { ChatService, type ChatResponse } from './chat-service.js';
import { ChannelTransport } from './channel-transport.js';
import { withTenantContext, db } from '../db.js';
import { llmRetryJobs } from '../models/delivery-record.js';
import { tryCasFinalDelivery } from './delivery-cas.js';
import pino from 'pino';

const logger = pino({ name: 'llm-retry-worker' });

const chatService = new ChatService();
const transport = new ChannelTransport();

// ---------------------------------------------------------------------------
// Queue configuration (spec §1.4: 1s→2s→4s→8s→16s, max 5 attempts)
// ---------------------------------------------------------------------------

const QUEUE_NAME = 'llm-retry';

const INITIAL_BACKOFF_MS = 1_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_ATTEMPTS = 5;

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
};

// ---------------------------------------------------------------------------
// Job payload — matches llm_retry_jobs.messages_payload shape
// ---------------------------------------------------------------------------

export interface LLMRetryJobPayload {
  tenantId: string;
  personaId: string;
  personaSlug: string;
  conversationId: string;
  channelMessageId: string;
  chatId: string;
  peerId: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

export interface LLMRetryJobResult {
  success: boolean;
  delivered: boolean;
  casWon: boolean;
  attemptsUsed: number;
  finalError?: string;
  content?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Enqueue helper — called from chat-service on hard timeout / LLM error
// ---------------------------------------------------------------------------

let retryQueue: Queue<LLMRetryJobPayload> | null = null;

function getRetryQueue(): Queue<LLMRetryJobPayload> {
  if (!retryQueue) {
    retryQueue = new Queue<LLMRetryJobPayload>(QUEUE_NAME, { connection: REDIS_CONFIG });
  }
  return retryQueue;
}

/**
 * Enqueue an llm-retry job.
 * Duplicate enqueues for the same (tenantId, conversationId, channelMessageId)
 * are de-duplicated at the DB level via llm_retry_jobs unique constraint —
 * the caller must INSERT the row first; if that INSERT succeeds, enqueue the
 * BullMQ job. If the INSERT fails (unique violation), skip the enqueue.
 */
export async function enqueueLLMRetry(
  payload: LLMRetryJobPayload,
): Promise<string> {
  const queue = getRetryQueue();

  const job = await queue.add('llm-retry', payload, {
    attempts: MAX_ATTEMPTS,
    backoff: {
      type: 'custom-exponential',
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
    jobId: `llm-retry:${payload.tenantId}:${payload.conversationId}:${payload.channelMessageId}`,
  });

  logger.info(
    {
      jobId: job.id,
      tenantId: payload.tenantId,
      personaId: payload.personaId,
      conversationId: payload.conversationId,
    },
    'enqueueLLMRetry: job queued',
  );

  return job.id ?? '';
}

// ---------------------------------------------------------------------------
// Mark llm_retry_jobs row status
// ---------------------------------------------------------------------------

async function markJobCompleted(
  tenantId: string,
  conversationId: string,
  channelMessageId: string,
): Promise<void> {
  await withTenantContext(tenantId, async (tx) => {
    await tx
      .update(llmRetryJobs)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(
        and(
          eq(llmRetryJobs.tenantId, tenantId),
          eq(llmRetryJobs.conversationId, conversationId),
          eq(llmRetryJobs.channelMessageId, channelMessageId),
        ),
      );
  });
}

async function markJobDLQ(
  tenantId: string,
  conversationId: string,
  channelMessageId: string,
  reason: string,
): Promise<void> {
  await withTenantContext(tenantId, async (tx) => {
    await tx
      .update(llmRetryJobs)
      .set({ status: 'dlq', updatedAt: new Date() })
      .where(
        and(
          eq(llmRetryJobs.tenantId, tenantId),
          eq(llmRetryJobs.conversationId, conversationId),
          eq(llmRetryJobs.channelMessageId, channelMessageId),
        ),
      );
  });

  logger.error(
    {
      tenantId,
      conversationId,
      channelMessageId,
      reason,
    },
    'DLQ: llm retry job exhausted — operator intervention required',
  );
}

// ---------------------------------------------------------------------------
// Core retry logic — re-run via ChatService.complete
// ---------------------------------------------------------------------------

async function executeRetryAttempt(
  payload: LLMRetryJobPayload,
  attempt: number,
): Promise<ChatResponse> {
  logger.info(
    {
      tenantId: payload.tenantId,
      personaId: payload.personaId,
      conversationId: payload.conversationId,
      attempt,
    },
    'executeRetryAttempt: re-running via ChatService',
  );

  return chatService.complete({
    tenantId: payload.tenantId,
    personaSlug: payload.personaSlug,
    personaId: payload.personaId,
    conversationId: payload.conversationId,
    messages: payload.messages,
    persist: false,
  });
}

// ---------------------------------------------------------------------------
// BullMQ Worker
// ---------------------------------------------------------------------------

export class LLMRetryWorker {
  private worker: Worker<LLMRetryJobPayload> | null = null;

  async start(): Promise<void> {
    if (this.worker) {
      logger.warn('LLMRetryWorker already started');
      return;
    }

    this.worker = new Worker<LLMRetryJobPayload>(
      QUEUE_NAME,
      async (job: Job<LLMRetryJobPayload>) => {
        const attempt = job.attemptsMade + 1;
        const { tenantId, conversationId, channelMessageId } = job.data;

        logger.info(
          {
            jobId: job.id,
            tenantId,
            conversationId,
            channelMessageId,
            attempt,
            maxAttempts: MAX_ATTEMPTS,
          },
          'Processing llm-retry attempt',
        );

        // 1. Re-run the LLM call
        const response = await executeRetryAttempt(job.data, attempt);
        const content = response.choices[0]?.message?.content || '';

        // 2. CAS on delivery_records — only deliver if we win the race
        const casWon = await tryCasFinalDelivery(
          tenantId,
          conversationId,
          channelMessageId,
        );

        if (!casWon) {
          // Someone else already delivered — mark job completed without sending
          logger.info(
            {
              jobId: job.id,
              tenantId,
              conversationId,
              channelMessageId,
            },
            'CAS lost — another path already delivered final answer, skipping delivery',
          );

          await markJobCompleted(tenantId, conversationId, channelMessageId);

          return {
            success: true,
            delivered: false,
            casWon: false,
            attemptsUsed: attempt,
            content,
            model: response.model,
          } satisfies LLMRetryJobResult;
        }

        // 3. Won the CAS — persist messages and deliver to channel
        try {
          await chatService.persistMessages(tenantId, conversationId, job.data.messages, content);

          await transport.publish(REDIS_STREAMS.OUTBOUND, {
            channel_id: job.data.chatId,
            message_id: channelMessageId,
            reply_to: channelMessageId,
            content,
            tenant_id: tenantId,
            external_user_id: job.data.peerId,
          });
        } catch (deliveryErr) {
          // Delivery failed — revert CAS so a later attempt or another path can retry
          logger.error(
            {
              err: deliveryErr,
              jobId: job.id,
              tenantId,
              conversationId,
              channelMessageId,
            },
            'Delivery to outbound stream failed — will retry on next attempt',
          );
          // Throw to trigger BullMQ retry (backoff applies)
          throw deliveryErr;
        }

        // 4. Mark llm_retry_jobs as completed
        await markJobCompleted(tenantId, conversationId, channelMessageId);

        logger.info(
          {
            jobId: job.id,
            tenantId,
            conversationId,
            channelMessageId,
            attempt,
          },
          'Retry completed — final answer delivered via CAS',
        );

        return {
          success: true,
          delivered: true,
          casWon: true,
          attemptsUsed: attempt,
          content,
          model: response.model,
        } satisfies LLMRetryJobResult;
      },
      {
        connection: REDIS_CONFIG,
        concurrency: parseInt(process.env.LLM_RETRY_CONCURRENCY || '5', 10),
        settings: {
          backoffStrategy: (attemptsMade: number) => {
            const delay =
              INITIAL_BACKOFF_MS *
              Math.pow(BACKOFF_MULTIPLIER, attemptsMade - 1);
            return delay;
          },
        },
      },
    );

    // ── Event handlers ──────────────────────────────────────────────────

    this.worker.on(
      'completed',
      async (job: Job<LLMRetryJobPayload>, result: LLMRetryJobResult) => {
        logger.info(
          {
            jobId: job.id,
            tenantId: job.data.tenantId,
            attemptsUsed: result.attemptsUsed,
            delivered: result.delivered,
            casWon: result.casWon,
            model: result.model,
          },
          'Retry job completed',
        );
      },
    );

    this.worker.on(
      'failed',
      async (job: Job<LLMRetryJobPayload> | undefined, err: Error) => {
        if (!job) return;

        const { tenantId, conversationId, channelMessageId } = job.data;

        logger.warn(
          {
            jobId: job.id,
            tenantId,
            conversationId,
            channelMessageId,
            attempt: job.attemptsMade,
            error: err.message,
            errorName: err.name,
          },
          'Retry attempt failed',
        );

        if (job.attemptsMade >= MAX_ATTEMPTS) {
          logger.error(
            {
              jobId: job.id,
              tenantId,
              conversationId,
              channelMessageId,
              attemptsMade: job.attemptsMade,
            },
            'Max attempts reached — moving to DLQ',
          );

          await markJobDLQ(
            tenantId,
            conversationId,
            channelMessageId,
            `Exhausted ${job.attemptsMade} attempts: ${err.message}`,
          );
        }
      },
    );
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Retention sweep (017-hybrid-agent-core, task 1.8)
// Purge llm_retry_jobs: completed >30d, dlq >90d. Contains PII.
// ---------------------------------------------------------------------------

const COMPLETED_RETENTION_DAYS = 30;
const DLQ_RETENTION_DAYS = 90;

export async function runRetryJobsRetentionSweep(): Promise<{ completed: number; dlq: number }> {
  let completedPurged = 0;
  let dlqPurged = 0;

  // Sweep completed >30d
  const completedCutoff = new Date(Date.now() - COMPLETED_RETENTION_DAYS * 86_400_000);
  const completedResult = await db
    .delete(llmRetryJobs)
    .where(
      and(
        eq(llmRetryJobs.status, 'completed'),
        lte(llmRetryJobs.updatedAt, completedCutoff),
      ),
    )
    .returning({ id: llmRetryJobs.id });
  completedPurged = completedResult.length;

  // Sweep dlq >90d
  const dlqCutoff = new Date(Date.now() - DLQ_RETENTION_DAYS * 86_400_000);
  const dlqResult = await db
    .delete(llmRetryJobs)
    .where(
      and(
        eq(llmRetryJobs.status, 'dlq'),
        lte(llmRetryJobs.updatedAt, dlqCutoff),
      ),
    )
    .returning({ id: llmRetryJobs.id });
  dlqPurged = dlqResult.length;

  if (completedPurged > 0 || dlqPurged > 0) {
    logger.info(
      { completedPurged, dlqPurged, completedCutoff, dlqCutoff },
      'Retention sweep completed',
    );
  }

  return { completed: completedPurged, dlq: dlqPurged };
}
