import type { Persona } from '@undrecreaitwins/shared';

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
  };
}

export interface AgentStepEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'answer' | 'done' | 'budget_exceeded' | 'error';
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
}

export class HermesExecutor {
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor() {
    this.baseUrl = process.env.HERMES_BASE_URL || 'http://localhost:8080';
    this.apiToken = process.env.HERMES_API_TOKEN || '';
  }

  async runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
    const steps: AgentStepEvent[] = [];
    const controller = new AbortController();

    const systemPrompt = this.buildSystemPrompt(input);
    const messages = [
      ...input.context.conversationHistory.map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: input.userMessage },
    ];

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
        ...(input.sessionId ? { 'X-Hermes-Session-Id': input.sessionId } : {}),
      },
      body: JSON.stringify({
        model: 'default',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
        max_tokens: input.budget.maxTokens,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Hermes API error: ${response.status} ${await response.text()}`);
    }

    let answer = '';
    let tokensUsed = 0;
    let loopIterations = 0;
    let toolCallsCount = 0;

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

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

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
          } catch {}
        }
      }
    }

    steps.push({ type: 'answer', content: answer });
    steps.push({ type: 'done' });

    return {
      answer,
      steps,
      usage: { loopIterations, tokensUsed, toolCallsCount },
      agentRunId: '',
    };
  }

  private buildSystemPrompt(input: RunAgentTurnInput): string {
    const parts: string[] = [];
    parts.push(`You are ${input.persona.name}, an AI assistant.`);
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
