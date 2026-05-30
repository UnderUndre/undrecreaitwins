import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { PersonaRepository } from './persona-repository.js';
import { FunnelRuntime } from './funnel/funnel-runtime.js';
import { FunnelRepository } from './funnel/funnel-repository.js';
import { FragmentScorer } from './funnel/scorer.js';
import { LettaClient } from '@undrecreaitwins/memory/letta-client.js';
import { withTenantContext } from '../db.js';
import { conversations, messages, usageEvents } from '../models/index.js';
import { ServiceUnavailableError, AppError, NotFoundError } from '@undrecreaitwins/shared';
import type { PersonaTraits, ModelPreferences, StreamChunk, FunnelSelectionMetadata } from '@undrecreaitwins/shared';

interface ChatRequest {
  tenantId: string;
  personaSlug: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  stream?: boolean;
  streamOptions?: { include_usage?: boolean };
  temperature?: number;
  maxTokens?: number;
}

interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'length';
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
};

const personaRepo = new PersonaRepository();
const letta = new LettaClient();
const funnelRepo = new FunnelRepository();
const funnelRuntime = new FunnelRuntime(funnelRepo, (config) => new FragmentScorer(config));

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

    const conversationId = await this.findOrCreateConversation(
      request.tenantId,
      persona.id,
      request.messages[0]?.content || '',
    );

    // Funnel Processing
    const funnelResult = await funnelRuntime.processMessage(
      request.tenantId,
      persona.id,
      conversationId,
      lastUserMessage
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

    const systemPrompt = this.buildSystemPrompt(persona);
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
    const llmResponse = await this.callLLM({
      messages: allMessages,
      temperature: request.temperature ?? persona.modelPreferences?.temperature,
      maxTokens: request.maxTokens ?? persona.modelPreferences?.max_tokens,
      model: persona.modelPreferences?.model,
    });
    const latencyMs = Date.now() - startTime;

    await this.persistMessages(
      request.tenantId,
      conversationId,
      request.messages,
      llmResponse.content,
    );

    await this.emitUsageEvent(
      request.tenantId,
      persona.id,
      conversationId,
      llmResponse.model,
      llmResponse.usage,
      latencyMs,
    );

    return {
      id: randomUUID(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: llmResponse.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: llmResponse.content },
        finish_reason: llmResponse.finishReason,
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
  ): AsyncGenerator<StreamChunk, { completed: boolean; content: string; conversationId?: string; personaId?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; metadata?: { funnel?: FunnelSelectionMetadata } }> {
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
    );

    const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user')?.content || '';

    // Funnel Processing
    const funnelResult = await funnelRuntime.processMessage(
      request.tenantId,
      persona.id,
      conversationId,
      lastUserMessage
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
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        metadata: { funnel: funnelResult.metadata }
      };
    }

    const systemPrompt = this.buildSystemPrompt(persona);
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
      const generator = this.callLLMStream({
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

    return {
      completed: true,
      content: accumulatedContent,
      conversationId,
      personaId: persona.id,
      usage: finalUsage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      metadata: { funnel: funnelResult.metadata }
    };
  }

  private async *callLLMStream(params: {
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
    model?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<StreamChunk> {
    const providerUrl = process.env.LLM_PROVIDER_URL || 'http://localhost:4000';
    const model = params.model || process.env.LLM_DEFAULT_MODEL || 'gpt-4o';
    const streamTimeout = Number(process.env.TWIN_STREAM_TIMEOUT_MS) || 30000;

    const internalAbort = new AbortController();

    let timeoutId: NodeJS.Timeout | undefined;
    const resetTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        internalAbort.abort(new AppError('Stream timeout from provider', 503, 'stream_timeout'));
      }, streamTimeout);
    };

    if (params.signal) {
      if (params.signal.aborted) {
        if (timeoutId) clearTimeout(timeoutId);
        internalAbort.abort(params.signal.reason);
      } else {
        params.signal.addEventListener('abort', () => {
          if (timeoutId) clearTimeout(timeoutId);
          internalAbort.abort(params.signal!.reason);
        }, { once: true });
      }
    }

    resetTimeout();

    let response: Response;
    try {
      response = await fetch(`${providerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.LLM_API_KEY && { Authorization: `Bearer ${process.env.LLM_API_KEY}` }),
        },
        body: JSON.stringify({
          model,
          messages: params.messages,
          temperature: params.temperature,
          max_tokens: params.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: internalAbort.signal,
      });
    } catch (err: any) {
      if (timeoutId) clearTimeout(timeoutId);
      if (params.signal?.aborted) {
        return;
      }
      if (internalAbort.signal.aborted && !params.signal?.aborted) {
        throw internalAbort.signal.reason || new AppError('LLM provider connection timeout', 503, 'stream_timeout');
      }
      throw err;
    }

    if (timeoutId) clearTimeout(timeoutId);

    if (!response.ok) {
      throw new ServiceUnavailableError('LLM provider', `Provider returned ${response.status}`);
    }

    if (!response.body) {
      throw new ServiceUnavailableError('LLM provider', 'Provider returned empty response body');
    }

    resetTimeout();

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        resetTimeout();

        buffer += value;
        if (Buffer.byteLength(buffer, 'utf8') > 65536) {
          throw new AppError('SSE buffer overflow from provider', 502, 'buffer_overflow');
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') {
              if (timeoutId) clearTimeout(timeoutId);
              return;
            }

            let parsed: StreamChunk;
            try {
              parsed = JSON.parse(dataStr) as StreamChunk;
            } catch {
              throw new AppError('Malformed SSE chunk from provider', 502, 'parse_error');
            }

            yield parsed;
          }
        }
      }

      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6);
          if (dataStr !== '[DONE]') {
            let parsed: StreamChunk;
            try {
              parsed = JSON.parse(dataStr) as StreamChunk;
              yield parsed;
            } catch {}
          }
        }
      }
    } catch (err: any) {
      if (timeoutId) clearTimeout(timeoutId);
      if (params.signal?.aborted) {
        return;
      }
      if (internalAbort.signal.aborted && !params.signal?.aborted) {
        throw internalAbort.signal.reason || new AppError('LLM provider stream timeout', 503, 'stream_timeout');
      }
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private buildSystemPrompt(persona: PersonaRow): string {
    const parts = [persona.systemPrompt];
    const traits = persona.traits;
    if (traits && Object.keys(traits).length > 0) {
      parts.push(`\nPersonality traits: ${JSON.stringify(traits)}`);
    }
    return parts.join('\n');
  }

  private async findOrCreateConversation(
    tenantId: string,
    personaId: string,
    _firstMessage: string,
  ): Promise<string> {
    return withTenantContext(tenantId, async (tx) => {
      const [conv] = await tx
        .insert(conversations)
        .values({
          tenantId,
          personaId,
          externalUserId: 'api',
          messageCount: 0,
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

      await tx
        .update(conversations)
        .set({
          messageCount: sql`${conversations.messageCount} + ${rows.length}`,
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
  ): Promise<void> {
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

  private async callLLM(params: {
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
    model?: string;
  }): Promise<{
    content: string;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    finishReason: 'stop' | 'length';
  }> {
    const providerUrl = process.env.LLM_PROVIDER_URL || 'http://localhost:4000';
    const model = params.model || process.env.LLM_DEFAULT_MODEL || 'gpt-4o';

    const response = await fetch(`${providerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LLM_API_KEY && { Authorization: `Bearer ${process.env.LLM_API_KEY}` }),
      },
      body: JSON.stringify({
        model,
        messages: params.messages,
        temperature: params.temperature,
        max_tokens: params.maxTokens,
      }),
    });

    if (!response.ok) {
      throw new ServiceUnavailableError('LLM provider', `Provider returned ${response.status}`);
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
      finishReason: (data.choices[0]?.finish_reason as 'stop' | 'length') || 'stop',
    };
  }
}

export type { ChatRequest, ChatResponse };
