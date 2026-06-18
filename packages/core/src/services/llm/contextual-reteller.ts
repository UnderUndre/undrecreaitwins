import { LLMClient } from '../llm-client.js';
import type { TurnMetrics } from '../funnel/turn-metrics.js';
import { getPrompt, interpolate } from '../../prompts/index.js';
import type { Locale } from '../../prompts/types.js';

export interface RetellResult {
  text: string;
  retellTriggered: boolean;
}

export async function contextualRetell(params: {
  fragmentContent: string;
  deliveryMode: string;
  conversationHistory: string[];
  isRevisit: boolean;
  llmClient: LLMClient;
  tenantId: string;
  personaId: string;
  remainingReruns: number;
  metrics?: TurnMetrics;
  locale?: Locale;
}): Promise<RetellResult> {
  const {
    fragmentContent,
    deliveryMode,
    conversationHistory,
    isRevisit,
    llmClient,
    tenantId,
    personaId,
    remainingReruns,
    metrics,
    locale = 'ru',
  } = params;

  if (!isRevisit) {
    if (metrics) metrics.stepSkipped('contextual_retell', 'first_visit');
    return { text: fragmentContent, retellTriggered: false };
  }

  if (deliveryMode === 'verbatim') {
    if (metrics) metrics.stepSkipped('contextual_retell', 'verbatim_mode');
    return { text: fragmentContent, retellTriggered: false };
  }

  if (remainingReruns <= 0) {
    if (metrics) metrics.stepSkipped('contextual_retell', 'rerun_budget_exhausted');
    return { text: fragmentContent, retellTriggered: false };
  }

  const historyBlock = conversationHistory
    .map((line, i) => `${i % 2 === 0 ? 'User' : 'Bot'}: ${line}`)
    .join('\n');

  const tpl = getPrompt('contextual-retell', locale);

  const systemPrompt = tpl.system;

  const userPrompt = interpolate(tpl.userTemplate!, {
    historyBlock,
    fragmentContent,
  });

  try {
    const response = await llmClient.complete({
      tenantId,
      personaId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      maxTokens: 300,
    });

    let text = response.content.trim();
    if (text.startsWith('"') && text.endsWith('"')) {
      text = text.slice(1, -1);
    }

    if (metrics) {
      metrics.stepFired('contextual_retell');
      metrics.recordLLMCall(response.usage);
    }

    return { text, retellTriggered: true };
  } catch (error) {
    console.warn('[ContextualRetell] LLM rewrite failed:', error);
    if (metrics) metrics.stepSkipped('contextual_retell', 'llm_error');
    return { text: fragmentContent, retellTriggered: false };
  }
}
