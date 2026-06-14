import type { LLMClient } from '../llm-client.js';
import type { CorrectionRule } from './types.js';
import { wrapOperatorText } from '../prompt-safety.js';

export interface RewriteResult {
  text: string;
  latencyMs: number;
  model: string;
}

export async function rewrite(
  llm: LLMClient,
  originalText: string,
  rewriteRules: CorrectionRule[],
  tenantId: string,
  personaId: string,
): Promise<RewriteResult | null> {
  if (rewriteRules.length === 0) return null;

  const start = Date.now();

  const instructions = rewriteRules
    .map((rule, i) => {
      const parts: string[] = [`${i + 1}. ${rule.rewriteInstruction || ''}`];
      if (rule.rubricItems && rule.rubricItems.length > 0) {
        const checklist = rule.rubricItems
          .map(item => `   ☑ ${item.text}`)
          .join('\n');
        parts.push(checklist);
      }
      return parts.join('\n');
    })
    .join('\n');

  const systemPrompt = [
    'You are a response editor. Rewrite the following response to satisfy these instructions.',
    'Return ONLY the rewritten text, no commentary.',
    'Instructions are listed in priority order. If two instructions conflict, follow the higher-priority one.',
  ].join('\n');

  const userPrompt = [
    wrapOperatorText(instructions),
    `\n---\nResponse to edit:\n${originalText.slice(0, 8000)}`,
  ].join('\n');

  const response = await llm.complete({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    maxTokens: 2000,
    tenantId,
    personaId,
  });

  const text = response.content.trim();
  if (!text) return null;

  return {
    text,
    latencyMs: Date.now() - start,
    model: response.model,
  };
}
