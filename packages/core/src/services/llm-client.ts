import { ServiceUnavailableError, AppError } from '@undrecreaitwins/shared';
import type { StreamChunk } from '@undrecreaitwins/shared';

export interface LLMMessage {
  role: string;
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  finishReason: 'stop' | 'length';
}

export interface BatchLLMRequest {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}

export interface BatchLLMResponse {
  content: string;
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
  private judgeModel: string;

  constructor() {
    this.providerUrl = process.env.LLM_PROVIDER_URL || 'http://localhost:4000';
    this.apiKey = process.env.LLM_API_KEY;
    this.defaultModel = process.env.LLM_DEFAULT_MODEL || 'gpt-4o';
    this.judgeModel = process.env.VALIDATOR_JUDGE_MODEL || this.defaultModel;
  }

  async complete(params: LLMRequest): Promise<LLMResponse> {
    const model = params.model || this.defaultModel;

    const response = await fetch(`${this.providerUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
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

  async *completeStream(params: {
    messages: LLMMessage[];
    temperature?: number;
    maxTokens?: number;
    model?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<StreamChunk> {
    const model = params.model || this.defaultModel;
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
      response = await fetch(`${this.providerUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
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

  /**
   * Batch completion for multiple prompts sharing a model.
   * Phase 1: Executes sequentially.
   */
  async completeBatch(requests: BatchLLMRequest[]): Promise<BatchLLMResponse[]> {
    const results: BatchLLMResponse[] = [];
    
    for (const req of requests) {
      const model = req.model || this.judgeModel;
      const res = await this.complete({
        model,
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
