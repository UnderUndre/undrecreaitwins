import { LLMClient } from '../llm-client.js';
import type { TurnMetrics } from '../funnel/turn-metrics.js';
import { getPrompt, interpolate } from '../../prompts/index.js';
import type { Locale } from '../../prompts/types.js';

export class AdaptiveIntroService {
  constructor(private llmClient: LLMClient, private locale: Locale = 'ru') {}

  public async generateIntro(params: {
    userMessage: string;
    fragmentObjective: string;
    tenantId: string;
    personaId: string;
    metrics?: TurnMetrics;
  }): Promise<string | null> {
    const tpl = getPrompt('adaptive-intro', this.locale);

    const systemPrompt = interpolate(tpl.system, {
      fragmentObjective: params.fragmentObjective,
    });

    const userPrompt = interpolate(tpl.userTemplate!, {
      userMessage: params.userMessage,
    });

    try {
      const response = await this.llmClient.complete({
        tenantId: params.tenantId,
        personaId: params.personaId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        maxTokens: 50
      });

      let content = response.content.trim();
      if (content.startsWith('"') && content.endsWith('"')) {
        content = content.slice(1, -1);
      }

      if (params.metrics) {
        params.metrics.stepFired('adaptive_intro');
        params.metrics.recordLLMCall(response.usage);
      }

      return content;
    } catch (error) {
      console.warn('[AdaptiveIntroService] Failed to generate intro:', error);
      return null;
    }
  }
}
