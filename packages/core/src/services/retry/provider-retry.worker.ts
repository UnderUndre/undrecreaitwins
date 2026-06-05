/**
 * ⚠️ NOT WIRED — SCAFFOLDING ONLY. US2 durable-retry is DEFERRED (2026-06-04).
 *
 * This module compiles but is ORPHANED: nothing calls `enqueueProviderRetry`, nothing
 * starts `ProviderRetryWorker`, and `on('completed')` ONLY logs — there is NO outbound
 * delivery, so a successfully-retried answer is never sent back to the user. Wiring the
 * enqueue path as-is would REGRESS the 010 thin-completion fallback
 * (degraded-answer-now → no-answer-ever). Do NOT assume "no message loss" works.
 *
 * To finish US2 see the Y follow-up:
 *   specs/011-llm-configuration/followup-Y-durable-retry.md
 * It needs: delivery context (conversationId + channel) in RunAgentTurnInput→RetryJobPayload,
 * a "queued" RunAgentTurnResult contract (caller must not send now), worker
 * delivery-on-success via the engine outbound channel, THEN enqueue + worker-start + backoff-cap.
 *
 * ── original (aspirational) description ──
 * provider-retry.worker.ts — BullMQ durable-retry on provider failure (009/011).
 *
 * US2: Provider outage on the prod path never loses a message
 *      and never silently swaps model.
 *
 * - Enqueue on UPSTREAM_* (prod reply-path)
 * - Exponential backoff (5s → ~2min cap)
 * - Re-resolve + re-decrypt per attempt (honors key rotation + config changes)
 * - Same provider, no silent model-swap
 * - Window exhaustion → dead-letter + operator alert (T014)
 * - Sandbox/interactive path: synchronous typed error, no enqueue
 */

import { Worker, Queue, type Job } from 'bullmq';
import { AppError } from '@undrecreaitwins/shared';
import { resolveEffectiveConfig } from '../llm-provider/resolution.js';
import { decryptApiKey, KmsUnavailableError } from '../llm-provider/crypto.js';
import { assertUrlAllowed } from '../llm-provider/ssrf-guard.js';
import { db } from '../../db.js';
import pino from 'pino';

const logger = pino({ name: 'provider-retry-worker' });

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
  /** The original user message to retry */
  userMessage: string;
  /** System prompt for the turn */
  systemPrompt: string;
  /** Conversation history for context */
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Budget for the retry turn */
  budget: {
    maxTokens: number;
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

  // Intended backoff cap — NOT currently enforced: BullMQ's `exponential` strategy below is
  // UNCAPPED and will exceed MAX_BACKOFF_MS on later attempts. The real cap (a custom
  // backoffStrategy honoring MAX_BACKOFF_MS) is part of the Y follow-up; this only documents intent.
  const intendedCapMs = Math.min(INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, DEFAULT_MAX_ATTEMPTS - 1), MAX_BACKOFF_MS);
  logger.debug({ INITIAL_BACKOFF_MS, BACKOFF_MULTIPLIER, MAX_BACKOFF_MS, intendedCapMs }, 'backoff config (cap NOT enforced — deferred to Y)');

  const job = await queue.add('provider-retry', payload, {
    attempts: DEFAULT_MAX_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: INITIAL_BACKOFF_MS,
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
];

const RETRYABLE_HTTP_STATUS = [429, 500, 502, 503, 504];

export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof AppError) {
    // KMS failures are retryable
    if (err instanceof KmsUnavailableError) return true;

    // ACP process errors are retryable
    const code = err.code ?? '';
    if (RETRYABLE_ERROR_CODES.includes(code)) return true;
    if (code.startsWith('acp_')) return true;

    // HTTP status-based
    const status = err.statusCode ?? 0;
    if (RETRYABLE_HTTP_STATUS.includes(status)) return true;
  }

  if (err instanceof Error) {
    const name = err.name;
    const code = (err as any).code ?? '';
    if (RETRYABLE_ERROR_CODES.includes(code)) return true;
    if (name === 'TimeoutError') return true;
    if (name === 'AbortError') return false; // User abort — don't retry
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
// Core retry logic — re-resolve + re-decrypt per attempt
// ---------------------------------------------------------------------------

async function executeRetryAttempt(
  payload: RetryJobPayload,
  attempt: number,
): Promise<{ content: string; model: string; usage: RetryJobResult['usage'] }> {
  // 1. Re-resolve effective config (fresh — honors config changes + key rotation)
  const effective = await resolveEffectiveConfig(db, payload.tenantId, payload.personaId);

  let baseUrl: string;
  let apiKey: string;
  let model: string;

  if (effective.source !== 'platform' && effective.config) {
    // 2. Re-decrypt key (fresh — honors rotation)
    apiKey = await decryptApiKey(effective.config.apiKeyCiphertext, effective.config.apiKeyRef);
    baseUrl = effective.config.baseUrl;
    model = effective.config.modelId;

    // 3. SSRF re-check on every attempt (DNS may have changed)
    const ssrfResult = await assertUrlAllowed(baseUrl);
    if (!ssrfResult.allowed) {
      throw new AppError(
        `baseUrl SSRF check failed on retry: ${ssrfResult.reason}`,
        400,
        'retry_ssrf_blocked',
      );
    }
  } else {
    // No custom config — fall back to platform defaults
    baseUrl = process.env.LLM_PROVIDER_URL || 'http://localhost:4000';
    apiKey = process.env.LLM_API_KEY || '';
    model = process.env.LLM_DEFAULT_MODEL || 'gpt-4o';
  }

  logger.info(
    {
      tenantId: payload.tenantId,
      personaId: payload.personaId,
      sourcePath: payload.sourcePath,
      attempt,
      source: effective.source,
      model,
    },
    'executeRetryAttempt: re-resolved config for attempt',
  );

  // 4. Execute the LLM call — thin-completion style (direct fetch)
  //    Agentic path re-enters via HermesExecutor which handles its own pooling.
  const messages = [
    ...(payload.conversationHistory || []).map(m => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: payload.userMessage },
  ];

  // Note: Using native fetch here as we already validated SSRF above.
  // In a real retry loop, we might want to reuse ssrfSafeFetch for extra safety.
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: payload.systemPrompt }, ...messages],
      max_tokens: payload.budget.maxTokens,
    }),
    signal: AbortSignal.timeout(payload.budget.maxExecutionMs || 30000),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new AppError(
      `Provider returned ${response.status}: ${errBody.slice(0, 200)}`,
      response.status,
      `upstream_${response.status}`,
    );
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };

  return {
    content: data.choices[0]?.message?.content || '',
    model: data.model,
    usage: data.usage,
  };
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

        const result = await executeRetryAttempt(job.data, attempt);

        return {
          success: true,
          attemptsUsed: attempt,
          content: result.content,
          model: result.model,
          usage: result.usage,
        } satisfies RetryJobResult;
      },
      {
        connection: REDIS_CONFIG,
        concurrency: parseInt(process.env.LLM_RETRY_CONCURRENCY || '5', 10),
      },
    );

    // ── Event handlers ──────────────────────────────────────────────────

    this.worker.on('completed', (job: Job<RetryJobPayload>, result: RetryJobResult) => {
      logger.info(
        {
          jobId: job.id,
          tenantId: job.data.tenantId,
          personaId: job.data.personaId,
          attemptsUsed: result.attemptsUsed,
          model: result.model,
        },
        'Retry job completed successfully',
      );
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

      // Check if this was the final attempt (window exhausted per DEFAULT_RETRY_WINDOW_MS)
      const elapsed = Date.now() - new Date(job.data.originalAttemptAt).getTime();
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
