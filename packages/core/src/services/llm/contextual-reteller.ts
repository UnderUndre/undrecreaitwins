import { LLMClient } from '../llm-client.js';
import type { TurnMetrics } from '../funnel/turn-metrics.js';

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
  } = params;

  // First visit — no retell needed
  if (!isRevisit) {
    if (metrics) metrics.stepSkipped('contextual_retell', 'first_visit');
    return { text: fragmentContent, retellTriggered: false };
  }

  // Verbatim fragments always deliver literally — skip retell (FR-017 / US-8)
  if (deliveryMode === 'verbatim') {
    if (metrics) metrics.stepSkipped('contextual_retell', 'verbatim_mode');
    return { text: fragmentContent, retellTriggered: false };
  }

  // Budget exhausted — skip retell, deliver as-is
  if (remainingReruns <= 0) {
    if (metrics) metrics.stepSkipped('contextual_retell', 'rerun_budget_exhausted');
    return { text: fragmentContent, retellTriggered: false };
  }

  const historyBlock = conversationHistory
    .map((line, i) => `${i % 2 === 0 ? 'User' : 'Bot'}: ${line}`)
    .join('\n');

  const systemPrompt = `Ты — редактор диалоговых фраз. Переформулируй предложенный фрагмент, сохраняя смысл, но меняя формулировку.

ПРАВИЛА:
1. Не повторяй дословно — перефразируй.
2. Сохраняй тон и стиль персоны.
3. Учитывай контекст диалога ниже.
4. Длина ответа — близка к оригиналу (±30%).
5. Не добавляй информацию, которой нет в оригинале.
6. Только переформулированный текст, без кавычек и комментариев.`;

  const userPrompt = `Контекст диалога:
${historyBlock}

Исходный фрагмент: «${fragmentContent}»

Переформулируй фрагмент с учётом контекста:`;

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
    console.error('[ContextualRetell] LLM rewrite failed:', error);
    if (metrics) metrics.stepSkipped('contextual_retell', 'llm_error');
    return { text: fragmentContent, retellTriggered: false };
  }
}
