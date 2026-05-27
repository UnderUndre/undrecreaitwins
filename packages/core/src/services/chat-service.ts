import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { PersonaRepository } from './persona-repository.js';
import { LettaClient } from '@undrecreaitwins/memory/letta-client.js';
import { withTenantContext } from '../db.js';
import { conversations, messages, usageEvents } from '../models/index.js';
import { ServiceUnavailableError } from '@undrecreaitwins/shared';
import type { PersonaTraits, ModelPreferences } from '@undrecreaitwins/shared';

interface ChatRequest {
  tenantId: string;
  personaSlug: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  stream?: boolean;
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
  version: bigint;
};

const personaRepo = new PersonaRepository();
const letta = new LettaClient();

export class ChatService {
  async complete(request: ChatRequest): Promise<ChatResponse> {
    if (request.messages.length === 0) {
      throw new ServiceUnavailableError('Chat', 'No messages provided');
    }

    const persona = await personaRepo.getBySlug(request.tenantId, request.personaSlug) as unknown as PersonaRow;

    const conversationId = await this.findOrCreateConversation(
      request.tenantId,
      persona.id,
      request.messages[0]?.content || '',
    );

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
      },
    };
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

  private async persistMessages(
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

  private async emitUsageEvent(
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
