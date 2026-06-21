import type { LLMClient } from '../../llm-client.js';
import type { CorrectionRule, Detector, DetectorResult } from '../types.js';
import { getPrompt, interpolate } from '../../../prompts/index.js';

const TIMEOUT_MS = parseInt(process.env.TWIN_DAR_SEMANTIC_TIMEOUT_MS || '5000', 10);

async function llmClassify(llm: LLMClient, systemPrompt: string, userText: string, tenantId: string, personaId: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await Promise.race([
        llm.complete({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userText.slice(0, 4000) },
          ],
          temperature: 0,
          maxTokens: 5,
          tenantId,
          personaId,
        }),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('Detector timeout')), TIMEOUT_MS);
          controller.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); });
        }),
      ]);

    const answer = response.content.trim().toUpperCase();
    return answer.startsWith('YES');
  } finally {
    clearTimeout(timeout);
  }
}

export class PatternDetector implements Detector {
  constructor(private llm: LLMClient) {}

  async detect(text: string, rule: CorrectionRule): Promise<DetectorResult> {
    const start = Date.now();
    if (rule.detector.type !== 'pattern') {
      return { triggered: false, latencyMs: 0 };
    }

    const { description } = rule.detector.config;
    const systemPrompt = interpolate(getPrompt('pattern-detector').system, { prompt: description });

    try {
      const triggered = await llmClassify(this.llm, systemPrompt, text, rule.tenantId, rule.assistantId || '');
      return { triggered, score: triggered ? 1 : 0, latencyMs: Date.now() - start };
    } catch (err) {
      console.error({ err, ruleId: rule.id }, '[PatternDetector] LLM call failed');
      return { triggered: false, latencyMs: Date.now() - start };
    }
  }
}

export class SemanticDetector implements Detector {
  constructor(private llm: LLMClient) {}

  async detect(text: string, rule: CorrectionRule): Promise<DetectorResult> {
    const start = Date.now();
    if (rule.detector.type !== 'semantic') {
      return { triggered: false, latencyMs: 0 };
    }

    const { prompt } = rule.detector.config;
    const systemPrompt = interpolate(getPrompt('pattern-detector').system, { prompt });

    try {
      const triggered = await llmClassify(this.llm, systemPrompt, text, rule.tenantId, rule.assistantId || '');
      return { triggered, score: triggered ? 1 : 0, latencyMs: Date.now() - start };
    } catch (err) {
      console.error({ err, ruleId: rule.id }, '[SemanticDetector] LLM call failed');
      return { triggered: false, latencyMs: Date.now() - start };
    }
  }
}
