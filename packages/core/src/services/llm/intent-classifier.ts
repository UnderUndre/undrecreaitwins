import { LLMClient } from '../llm-client.js';
import type { TurnMetrics } from '../funnel/turn-metrics.js';

export interface IntentClassificationResult {
  affirmative: boolean;
  source: 'regex' | 'llm';
}

const AFFIRMATIVE_REGEX = /\b(да|ок|давайте|хорошо|согласен|поехали|окей|угу|давай|го|точно|конечно|пожалуйста|yes|sure|ok|okay|let'?s|go\s*ahead|please)\b/i;

const NEGATION_REGEX = /\b(нет|не\s*(хочу|надо|нужно|буду|думаю|планирую|собираюсь))\b/i;

export class IntentClassifier {
  constructor(private llmClient: LLMClient) {}

  async classify(
    message: string,
    ctx: { tenantId: string; personaId: string; metrics?: TurnMetrics }
  ): Promise<IntentClassificationResult> {
    const normalized = message.trim().toLowerCase();

    if (NEGATION_REGEX.test(normalized)) {
      return { affirmative: false, source: 'regex' };
    }

    if (AFFIRMATIVE_REGEX.test(normalized)) {
      return { affirmative: true, source: 'regex' };
    }

    try {
      const response = await this.llmClient.complete({
        tenantId: ctx.tenantId,
        personaId: ctx.personaId,
        messages: [
          {
            role: 'system',
            content:
              "You are a binary intent classifier. Determine if the user's message is affirmative (agreement, confirmation, consent). Reply ONLY 'yes' or 'no'.",
          },
          {
            role: 'user',
            content: message,
          },
        ],
        temperature: 0,
        maxTokens: 5,
      });

      const answer = response.content.trim().toLowerCase();
      if (ctx.metrics) ctx.metrics.recordLLMCall(response.usage);
      return { affirmative: answer === 'yes', source: 'llm' };
    } catch {
      return { affirmative: false, source: 'llm' };
    }
  }
}
