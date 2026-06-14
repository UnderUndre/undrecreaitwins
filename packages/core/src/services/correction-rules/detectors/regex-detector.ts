import type { CorrectionRule, Detector, DetectorResult } from '../types.js';

export class RegexDetector implements Detector {
  async detect(text: string, rule: CorrectionRule): Promise<DetectorResult> {
    const start = Date.now();
    if (rule.detector.type !== 'regex') {
      return { triggered: false, latencyMs: 0 };
    }

    try {
      const { pattern, flags } = rule.detector.config;
      const re = new RegExp(pattern, flags || 'g');
      const triggered = re.test(text);
      return { triggered, latencyMs: Date.now() - start };
    } catch (err) {
      console.error({ err, ruleId: rule.id }, '[RegexDetector] Invalid pattern, skipping rule');
      return { triggered: false, latencyMs: Date.now() - start };
    }
  }
}
