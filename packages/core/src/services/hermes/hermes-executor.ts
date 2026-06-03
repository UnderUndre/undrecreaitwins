import type { Persona } from '@undrecreaitwins/shared';
import { AppError } from '@undrecreaitwins/shared';
import { LLMClient } from '../llm-client.js';
import pino from 'pino';

const logger = pino();

export interface RunAgentTurnInput {
  tenantId: string;
  persona: Persona;
  sessionId?: string;
  userMessage: string;
  context: {
    ragChunks?: string[];
    fewShotExamples?: Array<{ input: string; output: string }>;
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
  budget: {
    maxLoopIterations: number;
    maxTokens: number;
    maxExecutionMs?: number;
  };
}

export interface AgentStepEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'done' | 'budget_exceeded' | 'error' | 'timeout';
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
}

export interface RunAgentTurnResult {
  answer: string;
  steps: AgentStepEvent[];
  usage: {
    loopIterations: number;
    tokensUsed: number;
    toolCallsCount: number;
  };
  agentRunId: string;
  fallbackUsed?: boolean;
}

export class HermesExecutor {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly fallbackClient: LLMClient;

  constructor() {
    const baseUrl = process.env.HERMES_BASE_URL;
    if (!baseUrl) {
      throw new AppError('HERMES_BASE_URL is required', 500, 'configuration_error');
    }
    this.baseUrl = baseUrl;

    const apiToken = process.env.HERMES_API_TOKEN;
    if (!apiToken) {
      throw new AppError('HERMES_API_TOKEN is required', 500, 'configuration_error');
    }
    this.apiToken = apiToken;

    this.fallbackClient = new LLMClient();
  }

  async runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const steps: AgentStepEvent[] = [];
    const controller = new AbortController();

    // H2: Hard execution timeout
    const maxMs = input.budget.maxExecutionMs
      ?? (process.env.AGENT_MAX_EXECUTION_MS ? parseInt(process.env.AGENT_MAX_EXECUTION_MS, 10) : undefined);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (maxMs && Number.isFinite(maxMs) && maxMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, maxMs);
    }

    const systemPrompt = this.buildSystemPrompt(input);
    const model = input.persona.modelPreferences?.model ?? 'default';
    const messages = [
      ...input.context.conversationHistory.map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: input.userMessage },
    ];

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
          ...(input.sessionId ? { 'X-Hermes-Session-Id': input.sessionId } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          stream: true,
          max_tokens: input.budget.maxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Hermes API error, falling back to thin completion');
        return this.fallbackComplete(messages, systemPrompt, steps, input, model, 'Hermes API error');
      }

      let answer = '';
      let tokensUsed = 0;
      const loopIterations = 0;
      const toolCallsCount = 0;

      const handleSse = (raw: string): void => {
        if (!raw.startsWith('data: ')) return;
        const data = raw.slice(6).trim();
        if (data === '' || data === '[DONE]') return;
        try {
          const event = JSON.parse(data);
          const delta = event.choices?.[0]?.delta;
          if (delta?.content) {
            answer += delta.content;
            steps.push({ type: 'thinking', content: delta.content });
          }
          if (event.usage) {
            tokensUsed = event.usage.total_tokens ?? tokensUsed;
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to parse SSE event from Hermes');
        }
      };

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) handleSse(line);
        }

        // Flush decoder + process any residual buffered line (final chunk may lack a trailing newline).
        buffer += decoder.decode();
        if (buffer.trim()) handleSse(buffer.trim());
      }

      steps.push({ type: 'answer', content: answer });
      steps.push({ type: 'done' });

      return {
        answer,
        steps,
        usage: { loopIterations, tokensUsed, toolCallsCount },
        agentRunId: '',
      };
    } catch (err) {
      if (timedOut) {
        steps.push({ type: 'timeout', content: `Execution timed out after ${maxMs}ms` });
        logger.warn({ maxMs }, 'Hermes execution timeout, falling back');
        return this.fallbackComplete(messages, systemPrompt, steps, input, model, `Execution timeout after ${maxMs}ms`);
      }

      logger.warn({ err }, 'Hermes fetch failed, falling back to thin completion');
      return this.fallbackComplete(messages, systemPrompt, steps, input, model, err instanceof Error ? err.message : String(err));
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private async fallbackComplete(
    messages: Array<{ role: string; content: string }>,
    systemPrompt: string,
    steps: AgentStepEvent[],
    input: RunAgentTurnInput,
    model: string,
    _fallbackReason: string,
  ): Promise<RunAgentTurnResult> {
    const llmMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...messages,
    ];

    const llmResponse = await this.fallbackClient.complete({
      messages: llmMessages,
      model,
      maxTokens: input.budget.maxTokens,
    });

    steps.push({ type: 'answer', content: llmResponse.content });
    steps.push({ type: 'done' });

    return {
      answer: llmResponse.content,
      steps,
      usage: {
        loopIterations: 0,
        tokensUsed: llmResponse.usage.total_tokens,
        toolCallsCount: 0,
      },
      agentRunId: '',
      fallbackUsed: true,
    };
  }

  private buildSystemPrompt(input: RunAgentTurnInput): string {
    const parts: string[] = [];
    parts.push(input.persona.systemPrompt || `You are ${input.persona.name}, an AI assistant.`);
    if (input.context.ragChunks?.length) {
      parts.push('\nRelevant context:\n' + input.context.ragChunks.join('\n'));
    }
    if (input.context.fewShotExamples?.length) {
      parts.push('\nExamples:');
      for (const ex of input.context.fewShotExamples) {
        parts.push(`User: ${ex.input}\nAssistant: ${ex.output}`);
      }
    }
    return parts.join('\n');
  }
}
