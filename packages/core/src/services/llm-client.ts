import { ServiceUnavailableError, AppError } from '@undrecreaitwins/shared';
import type { StreamChunk } from '@undrecreaitwins/shared';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { resolveEffectiveConfig } from './llm-provider/resolution.js';
import { decryptApiKey } from './llm-provider/crypto.js';
import { ssrfSafeFetch } from './llm-provider/ssrf-audit.js';

export interface LLMMessage {
  role: string;
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  finishReason: 'stop' | 'length' | 'content_filter' | null;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class LLMClient {
  private providerUrl: string;
  private apiKey?: string;
  private defaultModel: string;

  constructor() {
    this.providerUrl = process.env.LLM_PROVIDER_URL || 'http://localhost:4000';
    this.apiKey = process.env.LLM_API_KEY;
    this.defaultModel = process.env.LLM_DEFAULT_MODEL || 'gpt-4o';
  }

  async complete(params: LLMRequest & { tenantId?: string; personaId?: string }): Promise<LLMResponse> {
    let baseUrl = this.providerUrl;
    let apiKey = this.apiKey;
    let model = params.model || this.defaultModel;

    // Resolve per-assistant/tenant config if context provided
    if (params.tenantId && params.personaId) {
      const effective = await resolveEffectiveConfig(db, params.tenantId, params.personaId);
      if (effective.source !== 'platform' && effective.config) {
        baseUrl = effective.config.baseUrl;
        model = params.model || effective.config.modelId;
        apiKey = await decryptApiKey(effective.config.apiKeyCiphertext, effective.config.apiKeyRef);
      }
    }

    const response = await ssrfSafeFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model,
        messages: params.messages,
        temperature: params.temperature,
        max_tokens: params.maxTokens,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new ServiceUnavailableError(`LLM provider error: ${error}`);
    }

    const data = await response.json() as any;
    return {
      content: data.choices[0].message.content,
      model: data.model ?? model,
      finishReason: data.choices[0].finish_reason ?? 'stop',
      usage: data.usage,
    };
  }

  async *completeStream(params: {
    messages: LLMMessage[];
    temperature?: number;
    maxTokens?: number;
    model?: string;
    signal?: AbortSignal;
    tenantId?: string;
    personaId?: string;
  }): AsyncGenerator<StreamChunk> {
    let baseUrl = this.providerUrl;
    let apiKey = this.apiKey;
    let model = params.model || this.defaultModel;

    // Resolve per-assistant/tenant config if context provided
    if (params.tenantId && params.personaId) {
      const effective = await resolveEffectiveConfig(db, params.tenantId, params.personaId);
      if (effective.source !== 'platform' && effective.config) {
        baseUrl = effective.config.baseUrl;
        model = params.model || effective.config.modelId;
        apiKey = await decryptApiKey(effective.config.apiKeyCiphertext, effective.config.apiKeyRef);
      }
    }

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
      response = await ssrfSafeFetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
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
      throw err;
    }

    if (!response.ok) {
      if (timeoutId) clearTimeout(timeoutId);
      const error = await response.text();
      throw new ServiceUnavailableError(`LLM provider error: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      if (timeoutId) clearTimeout(timeoutId);
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetTimeout();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const chunk: StreamChunk = {
                id: data.id ?? randomUUID(),
                object: 'chat.completion.chunk',
                created: data.created ?? Math.floor(Date.now() / 1000),
                model: data.model ?? model,
                choices: [{
                  index: data.choices[0]?.index ?? 0,
                  delta: { content: data.choices[0]?.delta?.content || '' },
                  finish_reason: data.choices[0]?.finish_reason ?? null,
                }],
                usage: data.usage,
              };
              yield chunk;
            } catch (e) {
              // ignore parse errors for partial chunks
            }
          }
        }
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      reader.releaseLock();
    }
  }

  /**
   * Batch-complete multiple prompts in parallel.
   * Used by validators that need to judge several items at once.
   * Per FR-005: each prompt gets its own complete() call — no silent model-swap.
   */
  async completeBatch(
    items: Array<{ systemPrompt: string; userPrompt: string; model?: string }>,
  ): Promise<Array<{ content: string; usage: LLMResponse['usage'] }>> {
    const results = await Promise.all(
      items.map(async (item) => {
        const res = await this.complete({
          messages: [
            { role: 'system', content: item.systemPrompt },
            { role: 'user', content: item.userPrompt },
          ],
          model: item.model,
        });
        return { content: res.content, usage: res.usage };
      }),
    );
    return results;
  }

  async validate(req: { systemPrompt: string; userPrompt: string }): Promise<Array<{ content: string; usage: any }>> {
    const validatorsStr = process.env.ACTIVE_VALIDATORS || '';
    const activeValidators = validatorsStr.split(',').filter(Boolean);
    const results = [];
    
    for (const _ of activeValidators) {
      const res = await this.complete({
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt }
        ]
      });
      
      results.push({
        content: res.content,
        usage: res.usage
      });
    }
    
    return results;
  }
}
