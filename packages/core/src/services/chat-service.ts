import { eq, sql, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { PersonaRepository } from './persona-repository.js';
import { FunnelRuntime } from './funnel/funnel-runtime.js';
import { FunnelRepository } from './funnel/funnel-repository.js';
import { FragmentScorer } from './funnel/scorer.js';
import { LLMClient } from './llm-client.js';
import { ValidatorPipeline } from './validators/pipeline.js';
import { LettaClient } from '@undrecreaitwins/memory/letta-client.js';
import { AnnotationService } from './annotation-service.js';
import { EmbeddingService } from './embedding-service.js';
import { LangfuseService } from './langfuse-service.js';
import { withTenantContext } from '../db.js';
import { groundingEngine } from './index.js';
import { conversations, messages, usageEvents, deliveryRecords, llmRetryJobs } from '../models/index.js';
import { ServiceUnavailableError, NotFoundError, AppError, REDIS_STREAMS } from '@undrecreaitwins/shared';
import type { PersonaTraits, ModelPreferences, StreamChunk, FunnelSelectionMetadata } from '@undrecreaitwins/shared';
import { routeTurn } from './hermes/turn-router.js';
import { HermesExecutor } from './hermes/hermes-executor.js';
import { ChannelTransport } from './channel-transport.js';
import { enqueueLLMRetry } from './llm-retry-worker.js';
import { isRetryableProviderError } from './retry/provider-retry.worker.js';
import { tryCasFinalDelivery } from './delivery-cas.js';

interface ChatRequest {
  tenantId: string;
  personaSlug: string;
  personaId?: string;
  conversationId?: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  stream?: boolean;
  streamOptions?: { include_usage?: boolean };
  temperature?: number;
  maxTokens?: number;
  isTestThread?: boolean;
  source?: string;
  persist?: boolean;
  /** Channel context — present only for channel conversations (not sandbox/API). Enables delivery ledger + fallback. */
  channelContext?: {
    channelMessageId: string;
    chatId: string;
    peerId: string;
  };
}

interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'length' | 'content_filter';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  metadata?: {
    conversation_id: string;
    degraded_mode?: boolean;
    funnel?: FunnelSelectionMetadata;
  };
}

type PersonaRow = {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  systemPrompt: string;
  traits: PersonaTraits;
  modelPreferences: ModelPreferences;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  annotationSimilarityThreshold: number;
  hasAnnotations: boolean;
  agentEnabled?: boolean;
  /** Soft fallback threshold in ms (017-hybrid-agent-core). */
  fallbackThresholdMs?: number;
  /** Rotating fallback messages for channel conversations. */
  fallbackMessages?: string[];
  /** RAG mode: 'static' (Phase 1) or 'tool' (Phase 2). */
  ragMode?: 'static' | 'tool';
  /** RAG relevance threshold for grounding. */
  ragRelevanceThreshold?: number;
  /** Strict RAG: refuse if no relevant chunks found (017-hybrid-agent-core, task 5.1). */
  strictRag?: boolean;
  /** Custom refusal text for strict RAG. NULL = built-in default. */
  strictRagRefusal?: string | null;
  /** Funnel generation mode: 'single' = 1 LLM call, 'dual' = 2 calls (FR-006). */
  funnelGeneration?: 'single' | 'dual';
  /** Response pacing config (FR-012, task 7.1) */
  pacingConfig?: { baseDelayMs: number; typingIndicator: boolean; randomVariation: boolean };
};

const personaRepo = new PersonaRepository();
const letta = new LettaClient();
const funnelRepo = new FunnelRepository();
const llm = new LLMClient();
const validatorPipeline = new ValidatorPipeline(llm);
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : undefined;
const funnelRuntime = new FunnelRuntime(funnelRepo, (config) => new FragmentScorer(config), redis as any);
const embeddingService = new EmbeddingService();
const annotationService = new AnnotationService(embeddingService);
const langfuseService = new LangfuseService();

// --- Fallback + retry infrastructure (017-hybrid-agent-core, task 1.5) ---
const HARD_TIMEOUT_MS = 60_000; // Hard fallback: 60s
const fallbackQueue = new Queue('llm-fallback', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
});
const channelTransport = new ChannelTransport();

// Per-conversation fallback rotation: maps convId → { index, ts } with TTL eviction
const FALLBACK_TTL_MS = 30 * 60 * 1000;
const lastFallbackIndex = new Map<string, { index: number; ts: number }>();

function getFallbackIndex(convId: string): number {
  const entry = lastFallbackIndex.get(convId);
  if (entry && Date.now() - entry.ts < FALLBACK_TTL_MS) {
    return entry.index;
  }
  return -1;
}

function setFallbackIndex(convId: string, index: number): void {
  lastFallbackIndex.set(convId, { index, ts: Date.now() });

  if (lastFallbackIndex.size > 5000) {
    const now = Date.now();
    for (const [key, val] of lastFallbackIndex) {
      if (now - val.ts > FALLBACK_TTL_MS) lastFallbackIndex.delete(key);
    }
  }
}

let hermesExecutor: HermesExecutor | undefined;
function getHermesExecutor(): HermesExecutor | undefined {
  if (process.env.AGENTIC_EXECUTOR_ENABLED !== 'true') return undefined;
  try {
    if (!hermesExecutor) hermesExecutor = new HermesExecutor();
    return hermesExecutor;
  } catch {
    return undefined;
  }
}

function isHermesHealthy(): boolean {
  return !!getHermesExecutor();
}

export class ChatService {
  async complete(request: ChatRequest): Promise<ChatResponse> {
    if (request.messages.length === 0) {
      throw new ServiceUnavailableError('Chat', 'No messages provided');
    }

    const persona = request.personaId 
      ? await personaRepo.getById(request.tenantId, request.personaId) as unknown as PersonaRow
      : await personaRepo.getBySlug(request.tenantId, request.personaSlug) as unknown as PersonaRow;
    if (!persona) {
      throw new NotFoundError('Persona', request.personaId || request.personaSlug);
    }

    const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user')?.content || '';

    // FR-002: Inbound sanitize (pre-generation)
    const sanitizedUserMessage = await validatorPipeline.validateInput(lastUserMessage, {
      tenantId: request.tenantId,
      personaId: persona.id
    });

    // FR-024: Empty-input guard
    if (lastUserMessage && !sanitizedUserMessage.trim()) {
       return {
         id: randomUUID(),
         object: 'chat.completion',
         created: Math.floor(Date.now() / 1000),
         model: 'system-guard',
         choices: [{
           index: 0,
           message: { role: 'assistant', content: "I'm sorry, I couldn't process your request. Could you please rephrase it?" },
           finish_reason: 'stop',
         }],
         usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
       };
    }

    const conversationId = request.conversationId || await this.findOrCreateConversation(
      request.tenantId,
      persona.id,
      request.messages[0]?.content || '',
      request.isTestThread,
      request.source,
    );

    // --- Delivery ledger + two-threshold fallback (017-hybrid-agent-core, task 1.5) ---
    const isChannel = !request.isTestThread && request.channelContext;
    let fallbackJobId: string | undefined;

    if (isChannel && request.channelContext) {
      const { channelMessageId } = request.channelContext;

      // (a) Create delivery ledger row: pending
      await this.createDeliveryRecord(request.tenantId, conversationId, channelMessageId);

      // (b) Schedule soft fallback timer via BullMQ delayed job
      const thresholdMs = persona.fallbackThresholdMs ?? 15000;
      try {
        const job = await fallbackQueue.add(
          'soft-fallback',
          {
            tenantId: request.tenantId,
            conversationId,
            channelMessageId,
            personaId: persona.id,
            chatId: request.channelContext.chatId,
            peerId: request.channelContext.peerId,
          },
          { delay: thresholdMs, removeOnComplete: { count: 200 } },
        );
        fallbackJobId = job.id ?? undefined;
      } catch (queueErr) {
        // Redis enqueue failed — degrade to in-process setTimeout + loud log, never silent
        console.error(
          { err: queueErr, tenantId: request.tenantId, conversationId },
          '[ChatService] CRITICAL: fallback queue enqueue failed — degrading to in-process timer',
        );
        setTimeout(() => {
          this.executeSoftFallback(
            request.tenantId,
            conversationId,
            channelMessageId,
            persona.id,
            request.channelContext!.chatId,
            request.channelContext!.peerId,
            persona.fallbackMessages ?? [],
          ).catch(() => {});
        }, thresholdMs).unref();
      }
    }

    // Pre-declare for catch block access (populated inside try after system prompt is built)
    let allMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    try {
      // Funnel Processing
      const funnelResult = await funnelRuntime.processMessage(
        request.tenantId,
        persona.id,
        conversationId,
        sanitizedUserMessage
      );

      if (funnelResult.scriptedReply) {
        await this.persistMessages(
          request.tenantId,
          conversationId,
          request.messages,
          funnelResult.scriptedReply,
        );

        return {
          id: randomUUID(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'script-funnel-1.0',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: funnelResult.scriptedReply },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          metadata: {
            conversation_id: conversationId,
            funnel: funnelResult.metadata,
          },
        };
      }

      const routing = routeTurn({
        hasActiveFunnel: !!funnelResult.metadata,
        agentEnabled: !!persona.agentEnabled,
        hermesHealthy: isHermesHealthy(),
      });

      if (routing.kind === 'agentic') {
        const executor = getHermesExecutor()!;
        const agentResult = await executor.runAgentTurn({
          tenantId: request.tenantId,
          persona: persona as any,
          sessionId: conversationId,
          userMessage: sanitizedUserMessage,
          context: {
            conversationHistory: request.messages
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          },
          budget: {
            maxLoopIterations: 20,
            maxTokens: request.maxTokens ?? persona.modelPreferences?.max_tokens ?? 4096,
            maxExecutionMs: parseInt(process.env.AGENT_MAX_EXECUTION_MS || '20000', 10),
          },
        });

        await this.persistMessages(
          request.tenantId,
          conversationId,
          request.messages,
          agentResult.answer,
        );

        return {
          id: randomUUID(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: persona.modelPreferences?.model || 'agent',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: agentResult.answer },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: agentResult.usage.tokensUsed,
            total_tokens: agentResult.usage.tokensUsed,
          },
          metadata: {
            conversation_id: conversationId,
            ...(agentResult.fallbackUsed && { degraded_mode: true }),
            funnel: funnelResult.metadata,
          },
        };
      }

      // Build funnel context for prompt injection (017-hybrid-agent-core, task 4.5)
      const funnelCtx = funnelResult.metadata?.type !== 'no_funnel'
        ? await this.buildFunnelContext(funnelResult, conversationId)
        : undefined;

      const { prompt: systemPrompt, strictRagRefused } = await this.buildSystemPrompt(request.tenantId, persona, sanitizedUserMessage, funnelCtx);

      // Strict RAG refusal — skip LLM call, return refusal directly (task 5.1)
      if (strictRagRefused) {
        return {
          id: `strict-rag-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'funnel-1.0',
          choices: [{ message: { role: 'assistant', content: systemPrompt }, index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      }

      allMessages = [
        { role: 'system', content: systemPrompt },
        ...request.messages,
      ];

      const lettaNamespace = `tenant_${request.tenantId}_persona_${persona.id}_conv_${conversationId}`;
      let lettaContext = '';
      let degradedMode = false;
      if (letta.isAvailable()) {
        try {
          const memory = await letta.getMemory(lettaNamespace);
          lettaContext = memory.map((m: { content: string }) => m.content).join('\n');
        } catch {
          degradedMode = true;
        }
      } else {
        degradedMode = true;
      }

      if (lettaContext) {
        allMessages.push({ role: 'system', content: `Memory context:\n${lettaContext}` });
      }

      const startTime = Date.now();

      // Wrap LLM call in hard-timeout race for channel conversations
      let llmResponse;
      if (isChannel) {
        const llmPromise = llm.complete({
          messages: allMessages,
          temperature: request.temperature ?? persona.modelPreferences?.temperature,
          maxTokens: request.maxTokens ?? persona.modelPreferences?.max_tokens,
          model: persona.modelPreferences?.model,
          tenantId: request.tenantId,
          personaId: persona.id,
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('HARD_TIMEOUT')), HARD_TIMEOUT_MS),
        );
        llmResponse = await Promise.race([llmPromise, timeoutPromise]);
      } else {
        llmResponse = await llm.complete({
          messages: allMessages,
          temperature: request.temperature ?? persona.modelPreferences?.temperature,
          maxTokens: request.maxTokens ?? persona.modelPreferences?.max_tokens,
          model: persona.modelPreferences?.model,
          tenantId: request.tenantId,
          personaId: persona.id,
        });
      }
      const latencyMs = Date.now() - startTime;

      // FR-001: Response validation (post-generation)
      const finalContent = await validatorPipeline.validateResponse(llmResponse.content, {
        tenantId: request.tenantId,
        personaId: persona.id,
        conversationId,
        rawUserMessage: lastUserMessage
      });

      if (request.persist !== false) {
        await this.persistMessages(
          request.tenantId,
          conversationId,
          request.messages,
          finalContent,
        );
      }

      await this.emitUsageEvent(
        request.tenantId,
        persona.id,
        conversationId,
        llmResponse.model,
        llmResponse.usage,
        latencyMs,
        allMessages,
        finalContent,
      );

      // CAS deliver + cancel fallback for channel conversations (017-hybrid-agent-core, task 1.5)
      if (isChannel && request.channelContext) {
        // Cancel scheduled soft fallback
        if (fallbackJobId) {
          try { await fallbackQueue.remove(fallbackJobId); } catch {}
        }

        // CAS: only deliver if no one else already did
        const casWon = await tryCasFinalDelivery(
          request.tenantId,
          conversationId,
          request.channelContext.channelMessageId,
        );

        if (casWon) {
          // Response pacing hold (017-hybrid-agent-core, task 7.1 / FR-012)
          const pacing = persona.pacingConfig;
          if (pacing && pacing.baseDelayMs > 0) {
            let delay = pacing.baseDelayMs;
            if (pacing.randomVariation) {
              // ±30% jitter
              const jitter = (Math.random() - 0.5) * 0.6; // -0.3..+0.3
              delay = Math.round(delay * (1 + jitter));
            }
            delay = Math.min(delay, 120_000); // hard cap

            console.log(
              { tenantId: request.tenantId, conversationId, delayMs: delay, baseMs: pacing.baseDelayMs },
              '[ChatService] Pacing hold before delivery',
            );

            // Drive typing indicator during hold if enabled
            if (pacing.typingIndicator) {
              this.scheduleTypingIndicator(
                request.channelContext.chatId,
                request.channelContext.peerId,
                request.tenantId,
                delay,
              ).catch((e) => {
                console.warn({ err: e }, '[ChatService] Typing indicator failed');
              });
            }

            await this.sleep(delay);
          }

          // Deliver to outbound channel
          try {
            await channelTransport.publish(REDIS_STREAMS.OUTBOUND, {
              channel_id: request.channelContext.chatId,
              message_id: request.channelContext.channelMessageId,
              reply_to: request.channelContext.channelMessageId,
              content: finalContent,
              tenant_id: request.tenantId,
              external_user_id: request.channelContext.peerId,
            });
          } catch (deliverErr) {
            console.error(
              { err: deliverErr, tenantId: request.tenantId, conversationId },
              '[ChatService] Failed to deliver answer to outbound stream',
            );
          }
        }
      }

      return {
        id: randomUUID(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: llmResponse.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: llmResponse.content },
          finish_reason: llmResponse.finishReason === 'length' ? 'length' : (llmResponse.finishReason === 'content_filter' ? 'content_filter' : 'stop'),
        }],
        usage: llmResponse.usage,
        metadata: {
          conversation_id: conversationId,
          ...(degradedMode && { degraded_mode: true }),
          funnel: funnelResult.metadata,
        },
      };
    } catch (err) {
      // Hard timeout / LLM error → enqueue retry for channel conversations
      if (isChannel && request.channelContext) {
        const isHardTimeout = err instanceof Error && err.message === 'HARD_TIMEOUT';
        const isLlmError = isRetryableProviderError(err);

        if (isHardTimeout || isLlmError) {
          try {
            const messagesToPersist = allMessages.length > 0 ? allMessages : request.messages;
            // Dedup: INSERT llm_retry_jobs row (unique constraint on tenant+conv+msg)
            await withTenantContext(request.tenantId, async (tx) => {
              await tx.insert(llmRetryJobs).values({
                personaId: persona.id,
                tenantId: request.tenantId,
                conversationId,
                channelMessageId: request.channelContext!.channelMessageId,
                messagesPayload: messagesToPersist,
                status: 'pending',
              });
            });

            // Enqueue BullMQ retry job
            await enqueueLLMRetry({
              tenantId: request.tenantId,
              personaId: persona.id,
              personaSlug: persona.slug,
              conversationId,
              channelMessageId: request.channelContext!.channelMessageId,
              chatId: request.channelContext!.chatId,
              peerId: request.channelContext!.peerId,
              messages: messagesToPersist,
            });
          } catch (retryErr) {
            console.error(
              { err: retryErr, tenantId: request.tenantId, conversationId },
              '[ChatService] Failed to enqueue retry job — message may be lost',
            );
          }
        }
      }

      if (err instanceof AppError) {
        err.context.conversationId = conversationId;
        err.context.personaId = persona.id;
      }
      throw err;
    }
  }

  async *completeStream(
    request: ChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk, { completed: boolean; content: string; conversationId?: string; personaId?: string; systemPrompt?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; metadata?: { funnel?: FunnelSelectionMetadata } }> {
    if (request.messages.length === 0) {
      throw new ServiceUnavailableError('Chat', 'No messages provided');
    }

    if (signal?.aborted) {
      return { completed: false, content: '' };
    }

    const persona = await personaRepo.getBySlug(request.tenantId, request.personaSlug) as unknown as PersonaRow;
    if (!persona) {
      throw new NotFoundError('Persona', request.personaSlug);
    }

    const conversationId = await this.findOrCreateConversation(
      request.tenantId,
      persona.id,
      request.messages[0]?.content || '',
      request.isTestThread,
      request.source,
    );

    const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user')?.content || '';

    // FR-002: Inbound sanitize (pre-generation)
    const sanitizedUserMessage = await validatorPipeline.validateInput(lastUserMessage, {
      tenantId: request.tenantId,
      personaId: persona.id
    });

    // FR-024: Empty-input guard
    if (lastUserMessage && !sanitizedUserMessage.trim()) {
      const chunk: StreamChunk = {
        id: randomUUID(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'system-guard',
        choices: [{
          index: 0,
          delta: { content: "I'm sorry, I couldn't process your request. Could you please rephrase it?" },
          finish_reason: 'stop',
        }],
      };
      yield chunk;
      return { completed: true, content: "I'm sorry, I couldn't process your request. Could you please rephrase it?", conversationId, personaId: persona.id, systemPrompt: '' };
    }

    // Funnel Processing
    const funnelResult = await funnelRuntime.processMessage(
      request.tenantId,
      persona.id,
      conversationId,
      sanitizedUserMessage
    );

    if (funnelResult.scriptedReply) {
      await this.persistMessages(
        request.tenantId,
        conversationId,
        request.messages,
        funnelResult.scriptedReply,
      );

      const chunk: StreamChunk = {
        id: randomUUID(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'script-funnel-1.0',
        choices: [{
          index: 0,
          delta: { content: funnelResult.scriptedReply },
          finish_reason: 'stop',
        }],
      };
      yield chunk;

      return {
        completed: true,
        content: funnelResult.scriptedReply,
        conversationId,
        personaId: persona.id,
        systemPrompt: '',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        metadata: { funnel: funnelResult.metadata }
      };
    }

    const streamingRouting = routeTurn({
      hasActiveFunnel: !!funnelResult.metadata,
      agentEnabled: !!persona.agentEnabled,
      hermesHealthy: isHermesHealthy(),
    });

    if (streamingRouting.kind === 'agentic') {
      const executor = getHermesExecutor()!;
      const agentResult = await executor.runAgentTurn({
        tenantId: request.tenantId,
        persona: persona as any,
        sessionId: conversationId,
        userMessage: sanitizedUserMessage,
        context: {
          conversationHistory: request.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        },
        budget: {
          maxLoopIterations: 20,
          maxTokens: request.maxTokens ?? persona.modelPreferences?.max_tokens ?? 4096,
          maxExecutionMs: parseInt(process.env.AGENT_MAX_EXECUTION_MS || '20000', 10),
        },
      });

      await this.persistMessages(
        request.tenantId,
        conversationId,
        request.messages,
        agentResult.answer,
      );

      const agentChunk: StreamChunk = {
        id: randomUUID(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: persona.modelPreferences?.model || 'agent',
        choices: [{
          index: 0,
          delta: { content: agentResult.answer },
          finish_reason: 'stop',
        }],
      };
      yield agentChunk;

      return {
        completed: true,
        content: agentResult.answer,
        conversationId,
        personaId: persona.id,
        systemPrompt: '',
        usage: { prompt_tokens: 0, completion_tokens: agentResult.usage.tokensUsed, total_tokens: agentResult.usage.tokensUsed },
        metadata: { funnel: funnelResult.metadata },
      };
    }

    // Build funnel context for prompt injection (017-hybrid-agent-core, task 4.5)
    const funnelCtx2 = funnelResult.metadata?.type !== 'no_funnel'
      ? await this.buildFunnelContext(funnelResult, conversationId)
      : undefined;

    const { prompt: systemPrompt, strictRagRefused } = await this.buildSystemPrompt(request.tenantId, persona, sanitizedUserMessage, funnelCtx2);

    // Strict RAG refusal — skip LLM call, stream refusal directly (task 5.1)
    if (strictRagRefused) {
      return {
        stream: true,
        [Symbol.asyncIterator]() {
          let sent = false;
          return {
            async next() {
              if (!sent) {
                sent = true;
                return { value: { choices: [{ delta: { content: systemPrompt }, index: 0 }] }, done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      } as any;
    }

    const allMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...request.messages,
    ];

    const lettaNamespace = `tenant_${request.tenantId}_persona_${persona.id}_conv_${conversationId}`;
    let lettaContext = '';
    if (letta.isAvailable()) {
      try {
        if (signal?.aborted) return { completed: false, content: '' };
        const memory = await letta.getMemory(lettaNamespace);
        lettaContext = memory.map((m: { content: string }) => m.content).join('\n');
      } catch {}
    }

    if (signal?.aborted) return { completed: false, content: '' };

    if (lettaContext) {
      allMessages.push({ role: 'system', content: `Memory context:\n${lettaContext}` });
    }

    let accumulatedContent = '';
    let finalUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    let modelName = persona.modelPreferences?.model || 'gpt-4o';
    const includeUsage = request.streamOptions?.include_usage === true;

    try {
      const generator = llm.completeStream({
        messages: allMessages,
        temperature: request.temperature ?? persona.modelPreferences?.temperature,
        maxTokens: request.maxTokens ?? persona.modelPreferences?.max_tokens,
        model: modelName,
        signal,
      });

      for await (const chunk of generator) {
        if (signal?.aborted) {
          return { completed: false, content: accumulatedContent };
        }

        if (chunk.choices?.[0]?.delta?.content) {
          accumulatedContent += chunk.choices[0].delta.content;
        }
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
        if (chunk.model) {
          modelName = chunk.model;
        }

        if (chunk.usage && !includeUsage) {
          const { usage: _u, ...chunkWithoutUsage } = chunk;
          yield chunkWithoutUsage as StreamChunk;
        } else {
          yield chunk;
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        return { completed: false, content: accumulatedContent };
      }
      throw err;
    }

    if (signal?.aborted) {
      return { completed: false, content: accumulatedContent };
    }

    // FR-019: Streaming-bypass telemetry
    validatorPipeline.recordBypass({
      tenantId: request.tenantId,
      personaId: persona.id,
      conversationId
    }, accumulatedContent).catch(err => {
      console.error('[ChatService] Failed to record streaming bypass', err);
    });

    return {
      completed: true,
      content: accumulatedContent,
      conversationId,
      personaId: persona.id,
      systemPrompt,
      usage: finalUsage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      metadata: { funnel: funnelResult.metadata }
    };
  }

  /**
   * Build funnel context from FunnelRuntime result for injection into system prompt.
   * Extracts stage name, captured slots, and prompt hint from conversation state.
   * (017-hybrid-agent-core, task 4.5)
   */
  private async buildFunnelContext(
    _funnelResult: { scriptedReply?: string; metadata: any },
    conversationId: string,
  ): Promise<{ stageName?: string; slots?: Record<string, string>; promptHint?: string } | undefined> {
    try {
      const state = await funnelRepo.getConversationState(conversationId);
      if (!state) return undefined;

      // Load funnel to get stage info
      const funnel = await funnelRepo.getFullVersion(state.funnelVersionId);
      if (!funnel) return undefined;

      const currentStage = funnel.stages.find((s: any) => s.id === state.currentStageId);
      if (!currentStage) return undefined;

      const slots: Record<string, string> = {};
      if (state.capturedSlots) {
        for (const [key, val] of Object.entries(state.capturedSlots as Record<string, any>)) {
          if (val?.value) slots[key] = val.value;
        }
      }

      return {
        stageName: currentStage.name,
        slots: Object.keys(slots).length > 0 ? slots : undefined,
        promptHint: (currentStage as any).objective || (currentStage as any).promptHint,
      };
    } catch {
      return undefined;
    }
  }

  private async buildSystemPrompt(
    tenantId: string,
    persona: PersonaRow,
    userQuery: string,
    funnelContext?: { stageName?: string; slots?: Record<string, string>; promptHint?: string }
  ): Promise<{ prompt: string; strictRagRefused?: boolean }> {
    const parts = [persona.systemPrompt];
    const traits = persona.traits;
    if (traits && Object.keys(traits).length > 0) {
      parts.push(`\nPersonality traits: ${JSON.stringify(traits)}`);
    }

    // Annotation few-shot injection (FR-003, US1)
    if (persona.hasAnnotations && userQuery) {
      try {
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Embedding timeout')), 500)
        );
        
        const embedding = await Promise.race([
          embeddingService.embed(userQuery.toLowerCase()),
          timeoutPromise
        ]) as number[];

        const matches = await annotationService.retrieve(
          tenantId,
          persona.id,
          embedding,
          persona.annotationSimilarityThreshold || 0.7,
          3
        );

        if (matches.length > 0) {
          parts.push('\nFollow these specific corrections for this query:');
          for (const m of matches) {
            parts.push(`Q: ${m.originalQuery}\nA: ${m.correctedResponse}`);
          }
        }
      } catch (err) {
        console.warn({ err }, 'Annotation retrieval failed, proceeding without few-shot');
      }
    }

    // RAG grounding injection (017-hybrid-agent-core, task 2.1)
    // Gate: rag_mode === 'static' (Phase 1 default; 'tool' is Phase 2)
    const ragMode = persona.ragMode ?? 'static';
    if (ragMode === 'static' && userQuery) {
      try {
        const threshold = persona.ragRelevanceThreshold ?? 0.3;
        const chunks = await groundingEngine.query(userQuery, tenantId, persona.id);

        const relevant = chunks.filter((c) => c.score >= threshold);
        if (relevant.length > 0) {
          parts.push('\nRelevant knowledge from uploaded documents:');
          for (const chunk of relevant.slice(0, 5)) {
            parts.push(
              `[doc:${chunk.metadata.documentId} chunk:${chunk.metadata.chunkIndex} score:${chunk.score.toFixed(3)}]\n${chunk.text}`,
            );
          }
        } else if (persona.strictRag) {
          // Strict RAG refusal (017-hybrid-agent-core, task 5.1)
          // Retrieval was attempted AND returned zero relevant chunks → refuse
          const refusal = persona.strictRagRefusal
            || 'К сожалению, у меня нет информации по этому вопросу. Пожалуйста, обратитесь к менеджеру.';
          return { prompt: refusal, strictRagRefused: true };
        }
      } catch (err) {
        console.warn({ err }, 'Grounding retrieval failed, proceeding without RAG');
      }
    }

    // Funnel context injection (017-hybrid-agent-core, task 4.5)
    if (funnelContext) {
      const funnelParts: string[] = ['\n\n## Funnel Context'];
      if (funnelContext.stageName) {
        funnelParts.push(`Current stage: ${funnelContext.stageName}`);
      }
      if (funnelContext.slots && Object.keys(funnelContext.slots).length > 0) {
        funnelParts.push('Captured slots:');
        for (const [key, value] of Object.entries(funnelContext.slots)) {
          funnelParts.push(`  ${key}: ${value}`);
        }
      }
      if (funnelContext.promptHint) {
        // Variable replacement: {{name}} → captured slot value
        let hint = funnelContext.promptHint;
        if (funnelContext.slots) {
          for (const [key, value] of Object.entries(funnelContext.slots)) {
            hint = hint.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
          }
        }
        funnelParts.push(`Stage objective: ${hint}`);
      }

      const genMode = persona.funnelGeneration ?? 'single';
      if (genMode === 'single') {
        funnelParts.push(
          '\nYou MUST respond with a JSON object:',
          '{"answer": "your response text", "stage_transition": true/false, "slots": {"slot_name": "extracted_value"}}',
          'If the JSON is malformed, your response will be treated as a plain answer without stage transition.'
        );
      }

      parts.push(funnelParts.join('\n'));
    }

    return { prompt: parts.join('\n') };
  }

  private async findOrCreateConversation(
    tenantId: string,
    personaId: string,
    _firstMessage: string,
    isTestThread = false,
    source?: string,
  ): Promise<string> {
    return withTenantContext(tenantId, async (tx) => {
      const [conv] = await tx
        .insert(conversations)
        .values({
          tenantId,
          personaId,
          externalUserId: 'api',
          messageCount: 0,
          isTestThread,
          source,
        })
        .returning({ id: conversations.id });
      if (!conv) {
        throw new ServiceUnavailableError('Database', 'Failed to create conversation');
      }
      return conv.id;
    });
  }

  public async persistMessages(
    tenantId: string,
    conversationId: string,
    inboundMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    assistantContent: string,
  ): Promise<void> {
    return withTenantContext(tenantId, async (tx) => {
      const rows = [
        ...inboundMessages.map((m) => ({
          conversationId,
          role: m.role,
          content: m.content,
        })),
        {
          conversationId,
          role: 'assistant' as const,
          content: assistantContent,
        },
      ];
      await tx.insert(messages).values(rows);

      const hasUserMessage = inboundMessages.some(m => m.role === 'user');

      await tx
        .update(conversations)
        .set({
          messageCount: sql`${conversations.messageCount} + ${rows.length}`,
          lastMessageAt: new Date(),
          ...(hasUserMessage && {
            needsReengagement: true,
            reengagementCount: 0,
          }),
        })
        .where(eq(conversations.id, conversationId));
    });
  }

  public async emitUsageEvent(
    tenantId: string,
    personaId: string,
    conversationId: string,
    model: string,
    usage: { prompt_tokens: number; completion_tokens: number },
    latencyMs: number,
    messages?: any[],
    output?: string,
  ): Promise<void> {
    // Fire-and-forget Langfuse trace (US4)
    langfuseService.emitTrace({
      id: randomUUID(),
      name: 'chat-reply',
      userId: tenantId,
      metadata: { personaId, conversationId, tenantId },
      input: messages,
      output: output,
      model,
      usage,
    });

    return withTenantContext(tenantId, async (tx) => {
      await tx.insert(usageEvents).values({
        tenantId,
        personaId,
        conversationId,
        provider: 'default',
        model,
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        latencyMs,
      });
    });
  }

  // --- Delivery ledger helpers (017-hybrid-agent-core, task 1.5) ---

  private async createDeliveryRecord(
    tenantId: string,
    conversationId: string,
    channelMessageId: string,
  ): Promise<void> {
    await withTenantContext(tenantId, async (tx) => {
      await tx.insert(deliveryRecords).values({
        tenantId,
        conversationId,
        channelMessageId,
        state: 'pending',
      });
    });
  }

  /** Sleep helper for pacing hold (task 7.1) */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Drive typing indicator during pacing hold (task 7.1 / FR-012).
   * Sends periodic typing actions to the channel adapter via Redis stream.
   */
  private async scheduleTypingIndicator(
    chatId: string,
    peerId: string,
    tenantId: string,
    durationMs: number,
  ): Promise<void> {
    // Send typing action every 4s (Telegram typing expires after ~5s)
    const interval = 4_000;
    let elapsed = 0;
    while (elapsed < durationMs) {
      try {
        await channelTransport.publish(REDIS_STREAMS.OUTBOUND, {
          channel_id: chatId,
          action: 'typing',
          tenant_id: tenantId,
          external_user_id: peerId,
        });
      } catch {
        // Non-critical — typing is cosmetic
      }
      await this.sleep(Math.min(interval, durationMs - elapsed));
      elapsed += interval;
    }
  }

  /**
   * Execute soft fallback: pick a fallback message with rotation,
   * CAS pending → fallback_sent, deliver to channel.
   * Called by the BullMQ 'llm-fallback' worker OR in-process setTimeout fallback.
   */
  public async executeSoftFallback(
    tenantId: string,
    conversationId: string,
    channelMessageId: string,
    _personaId: string,
    chatId: string,
    peerId: string,
    fallbackMessages: string[],
  ): Promise<void> {
    if (!fallbackMessages.length) return;

    // CAS: pending → fallback_sent
    const casResult = await withTenantContext(tenantId, async (tx) => {
      const rows = await tx
        .update(deliveryRecords)
        .set({ state: 'fallback_sent' as const, updatedAt: new Date() })
        .where(
          and(
            eq(deliveryRecords.tenantId, tenantId),
            eq(deliveryRecords.conversationId, conversationId),
            eq(deliveryRecords.channelMessageId, channelMessageId),
            eq(deliveryRecords.state, 'pending'),
          ),
        )
        .returning({ id: deliveryRecords.id });
      return rows.length > 0;
    });

    if (!casResult) return; // already in fallback_sent or final_delivered

    // Pick fallback with rotation (random excluding last-used index)
    const lastIdx = getFallbackIndex(conversationId);
    let idx: number;
    if (fallbackMessages.length === 1) {
      idx = 0;
    } else {
      do {
        idx = Math.floor(Math.random() * fallbackMessages.length);
      } while (idx === lastIdx);
    }
    setFallbackIndex(conversationId, idx);
    const fallbackText = fallbackMessages[idx] ?? '';

    // Deliver to channel
    await channelTransport.publish(REDIS_STREAMS.OUTBOUND, {
      channel_id: chatId,
      message_id: channelMessageId,
      reply_to: channelMessageId,
      content: fallbackText,
      tenant_id: tenantId,
      external_user_id: peerId,
    });
  }
}

export type { ChatRequest, ChatResponse };
