import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
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
import { conversations, messages, usageEvents } from '../models/index.js';
import { ServiceUnavailableError, NotFoundError } from '@undrecreaitwins/shared';
import type { PersonaTraits, ModelPreferences, StreamChunk, FunnelSelectionMetadata } from '@undrecreaitwins/shared';

interface ChatRequest {
  tenantId: string;
  personaSlug: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  stream?: boolean;
  streamOptions?: { include_usage?: boolean };
  temperature?: number;
  maxTokens?: number;
  isTestThread?: boolean;
  source?: string;
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

export class ChatService {
  async complete(request: ChatRequest): Promise<ChatResponse> {
    if (request.messages.length === 0) {
      throw new ServiceUnavailableError('Chat', 'No messages provided');
    }

    const persona = await personaRepo.getBySlug(request.tenantId, request.personaSlug) as unknown as PersonaRow;
    if (!persona) {
      throw new NotFoundError('Persona', request.personaSlug);
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

    const conversationId = await this.findOrCreateConversation(
      request.tenantId,
      persona.id,
      request.messages[0]?.content || '',
      request.isTestThread,
      request.source,
    );

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

    const systemPrompt = await this.buildSystemPrompt(request.tenantId, persona, sanitizedUserMessage);
    const allMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
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
    const llmResponse = await llm.complete({
      messages: allMessages,
      temperature: request.temperature ?? persona.modelPreferences?.temperature,
      maxTokens: request.maxTokens ?? persona.modelPreferences?.max_tokens,
      model: persona.modelPreferences?.model,
    });
    const latencyMs = Date.now() - startTime;

    // FR-001: Response validation (post-generation)
    const finalContent = await validatorPipeline.validateResponse(llmResponse.content, {
      tenantId: request.tenantId,
      personaId: persona.id,
      conversationId,
      rawUserMessage: lastUserMessage
    });

    await this.persistMessages(
      request.tenantId,
      conversationId,
      request.messages,
      finalContent,
    );

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

    const systemPrompt = await this.buildSystemPrompt(request.tenantId, persona, sanitizedUserMessage);
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

  private async buildSystemPrompt(tenantId: string, persona: PersonaRow, userQuery: string): Promise<string> {
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

    return parts.join('\n');
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
}

export type { ChatRequest, ChatResponse };
