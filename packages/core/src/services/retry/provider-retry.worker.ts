import { Worker, Queue, type Job, UnrecoverableError } from 'bullmq';
import { AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import type { ChatResponse } from '../chat-service.js';
import { ChannelTransport } from '../channel-transport.js';
import pino from 'pino';

const logger = pino({ name: 'provider-retry-worker' });

const transport = new ChannelTransport();

async function getChatService() {
  const mod = await import('../chat-service.js');
  return new mod.ChatService();
}

// ---------------------------------------------------------------------------
// Queue configuration
// ---------------------------------------------------------------------------

const QUEUE_NAME = 'llm-provider-retry';

/** Backoff: 5s → 10s → 20s → 40s → 80s → 120s cap */
const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 120_000;
const BACKOFF_MULTIPLIER = 2;

const DEFAULT_MAX_ATTEMPTS = parseInt(process.env.LLM_RETRY_MAX_ATTEMPTS || '8', 10);
const DEFAULT_RETRY_WINDOW_MS = parseInt(process.env.LLM_RETRY_WINDOW_MS || '1800000', 10); // 30 min

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
};

// ---------------------------------------------------------------------------
// Job payload
// ---------------------------------------------------------------------------

export interface RetryJobPayload {
  /** Tenant ID — for resolution scope */
  tenantId: string;
  /** Persona (assistant) ID — for resolution scope */
  personaId: string;
  /** Persona slug — for calling ChatService.complete */
  personaSlug: string;
  /** Conversation ID — for calling ChatService.complete */
  conversationId: string;
  /** Channel type */
  channelType: string;
  /** Channel chat ID (externalUserId) */
  chatId: string;
  /** Peer ID (e.g. for logging) */
  peerId: string;
  /** Original channel message ID */
  originalMessageId: string;
  /** The original user message to retry */
  userMessage: string;
  /** System prompt for the turn */
  systemPrompt: string;
  /** Conversation history for context */
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Budget for the retry turn */
  budget: {
    maxTokens?: number;
    maxExecutionMs?: number;
  };
  /** Original error that triggered the retry */
  originalError: {
    message: string;
    code: string;
  };
  /** When the original attempt was made */
  originalAttemptAt: string; // ISO timestamp
  /** Source path: 'prod' for agentic, 'thin' for completion */
  sourcePath: 'prod' | 'thin';
}

export interface RetryJobResult {
  success: boolean;
  attemptsUsed: number;
  finalError?: string;
  /** The LLM response content if success */
  content?: string;
  model?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Enqueue helper — called from hermes-executor / llm-client on UPSTREAM_*
// ---------------------------------------------------------------------------

let retryQueue: Queue<RetryJobPayload> | null = null;

function getRetryQueue(): Queue<RetryJobPayload> {
  if (!retryQueue) {
    retryQueue = new Queue<RetryJobPayload>(QUEUE_NAME, { connection: REDIS_CONFIG });
  }
  return retryQueue;
}

/**
 * Enqueue a provider-retry job.
 * Called only from the prod reply-path on UPSTREAM_* errors.
 * Sandbox/interactive paths should NOT call this — they get synchronous errors.
 */
export async function enqueueProviderRetry(
  payload: RetryJobPayload,
): Promise<string> {
  const queue = getRetryQueue();

  const job = await queue.add('provider-retry', payload, {
    attempts: DEFAULT_MAX_ATTEMPTS,
    backoff: {
      type: 'custom-exponential',
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
    // Tag with tenant+persona for monitoring
    jobId: `retry:${payload.tenantId}:${payload.personaId}:${Date.now()}`,
  });

  logger.info(
    {
      jobId: job.id,
      tenantId: payload.tenantId,
      personaId: payload.personaId,
      sourcePath: payload.sourcePath,
      originalError: payload.originalError.code,
    },
    'enqueueProviderRetry: job queued',
  );

  return job.id ?? '';
}

// ---------------------------------------------------------------------------
// Error classification — which errors are retryable
// ---------------------------------------------------------------------------

const RETRYABLE_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'acp_process_exit',
  'acp_process_error',
  'stream_timeout',
  'acp_aborted',
  'service_unavailable', // Added for ServiceUnavailableError
];

const RETRYABLE_HTTP_STATUS = [429, 500, 502, 503, 504];

export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof AppError) {
    const code = err.code ?? '';
    if (RETRYABLE_ERROR_CODES.includes(code)) return true;
    if (code.startsWith('acp_')) return true;

    // HTTP status-based
    const status = err.statusCode ?? 0;
    if (RETRYABLE_HTTP_STATUS.includes(status)) return true;
  }

  if (err instanceof Error) {
    const name = err.name;
    const code = 'code' in err ? String(err.code) : '';
    if (RETRYABLE_ERROR_CODES.includes(code)) return true;
    if (name === 'TimeoutError') return true;
    if (name === 'AbortError') return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Dead-letter + alert (T014)
// ---------------------------------------------------------------------------

const DEAD_LETTER_QUEUE_NAME = 'llm-provider-dead-letter';

let deadLetterQueue: Queue<RetryJobPayload & { deadLetterReason: string }> | null = null;

function getDeadLetterQueue(): Queue<RetryJobPayload & { deadLetterReason: string }> {
  if (!deadLetterQueue) {
    deadLetterQueue = new Queue(QUEUE_NAME + '-dead-letter', { connection: REDIS_CONFIG });
  }
  return deadLetterQueue;
}

/**
 * Move an exhausted job to dead-letter queue and emit an operator alert.
 */
async function moveToDeadLetter(job: Job<RetryJobPayload>, reason: string): Promise<void> {
  const dlq = getDeadLetterQueue();

  const payload = {
    ...job.data,
    deadLetterReason: reason,
  };

  await dlq.add('dead-letter', payload, {
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
    jobId: `dl:${job.data.tenantId}:${job.data.personaId}:${Date.now()}`,
  });

  // Operator alert via structured log (ops picks up from log aggregation)
  logger.error(
    {
      deadLetter: true,
      originalJobId: job.id,
      tenantId: job.data.tenantId,
      personaId: job.data.personaId,
      originalError: job.data.originalError,
      reason,
      sourcePath: job.data.sourcePath,
      attemptsMade: job.attemptsMade,
      originalAttemptAt: job.data.originalAttemptAt,
    },
    'DEAD-LETTER: provider retry window exhausted — operator intervention required',
  );
}

// ---------------------------------------------------------------------------
// Core retry logic — use ChatService.complete for full pipeline integration
// ---------------------------------------------------------------------------

async function executeRetryAttempt(
  payload: RetryJobPayload,
  _attempt: number,
): Promise<ChatResponse> {
  logger.info(
    {
      tenantId: payload.tenantId,
      personaId: payload.personaId,
      sourcePath: payload.sourcePath,
      conversationId: payload.conversationId,
    },
    'executeRetryAttempt: re-running via ChatService',
  );

  const chatService = await getChatService();
  return chatService.complete({
    tenantId: payload.tenantId,
    personaSlug: payload.personaSlug,
    personaId: payload.personaId,
    conversationId: payload.conversationId,
    messages: [
      ...payload.conversationHistory,
      { role: 'user', content: payload.userMessage },
    ],
    ...(payload.budget.maxTokens != null && { maxTokens: payload.budget.maxTokens }),
  });
}

// ---------------------------------------------------------------------------
// BullMQ Worker
// ---------------------------------------------------------------------------

export class ProviderRetryWorker {
  private worker: Worker<RetryJobPayload> | null = null;

  async start(): Promise<void> {
    if (this.worker) {
      logger.warn('ProviderRetryWorker already started');
      return;
    }

    this.worker = new Worker<RetryJobPayload>(
      QUEUE_NAME,
      async (job: Job<RetryJobPayload>) => {
        const attempt = job.attemptsMade + 1;

        const originalTs = new Date(job.data.originalAttemptAt).getTime();
        const elapsed = Number.isFinite(originalTs) ? Date.now() - originalTs : 0;
        if (elapsed >= DEFAULT_RETRY_WINDOW_MS) {
          throw new UnrecoverableError(`Retry window exhausted after ${elapsed}ms`);
        }

        logger.info(
          {
            jobId: job.id,
            tenantId: job.data.tenantId,
            personaId: job.data.personaId,
            attempt,
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
          },
          'Processing retry attempt',
        );

        const response = await executeRetryAttempt(job.data, attempt);

        return {
          success: true,
          attemptsUsed: attempt,
          content: response.choices[0]?.message?.content || '',
          model: response.model,
          usage: response.usage,
        } satisfies RetryJobResult;
      },
      {
        connection: REDIS_CONFIG,
        concurrency: parseInt(process.env.LLM_RETRY_CONCURRENCY || '5', 10),
        settings: {
          backoffStrategy: (attemptsMade: number) => {
            const delay = INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attemptsMade - 1);
            return Math.min(delay, MAX_BACKOFF_MS);
          },
        },
      },
    );

    // ── Event handlers ──────────────────────────────────────────────────

    this.worker.on('completed', async (job: Job<RetryJobPayload>, result: RetryJobResult) => {
      logger.info(
        {
          jobId: job.id,
          tenantId: job.data.tenantId,
          personaId: job.data.personaId,
          attemptsUsed: result.attemptsUsed,
          model: result.model,
        },
        'Retry job completed successfully — delivering answer',
      );

      // DELIVER the answer back to the channel (LOAD-BEARING)
      try {
        await transport.publish(REDIS_STREAMS.OUTBOUND, {
          channel_id: job.data.chatId,
          message_id: job.data.originalMessageId,
          reply_to: job.data.originalMessageId,
          content: result.content || '',
          tenant_id: job.data.tenantId,
          external_user_id: job.data.peerId,
        });
      } catch (err) {
        logger.error({ err, jobId: job.id }, 'Failed to deliver successfully-retried answer to outbound stream — moving to dead-letter');
        await moveToDeadLetter(job, `Delivery failed after successful retry: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.worker.on('failed', async (job: Job<RetryJobPayload> | undefined, err: Error) => {
      if (!job) return;

      logger.warn(
        {
          jobId: job.id,
          tenantId: job.data.tenantId,
          personaId: job.data.personaId,
          attempt: job.attemptsMade,
          error: err.message,
          errorName: err.name,
        },
        'Retry attempt failed',
      );

      const originalTs = new Date(job.data.originalAttemptAt).getTime();
      const elapsed = Number.isFinite(originalTs) ? Date.now() - originalTs : 0;
      const windowExhausted = elapsed >= DEFAULT_RETRY_WINDOW_MS;
      const maxAttempts = job.opts?.attempts ?? DEFAULT_MAX_ATTEMPTS;
      if (job.attemptsMade >= maxAttempts || windowExhausted) {
        logger.warn({ DEAD_LETTER_QUEUE_NAME, windowExhausted, elapsed, DEFAULT_RETRY_WINDOW_MS }, 'moving to dead-letter queue');
        await moveToDeadLetter(job, `Window exhausted after ${job.attemptsMade} attempts${windowExhausted ? ' (time window)' : ''}: ${err.message}`);
        // Halt further BullMQ retries — esp. window-exhausted-but-attempts-remain, which would
        // otherwise keep retrying AND duplicate into the dead-letter queue. NOTE: discard() in the
        // 'failed' handler is best-effort; the robust fix (throw UnrecoverableError / check the
        // window inside the processor) is part of the Y follow-up.
        await job.discard();
      }
    });
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }
}
