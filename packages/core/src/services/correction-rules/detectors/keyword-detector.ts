import type { CorrectionRule, Detector, DetectorResult } from '../types.js';

export class KeywordDetector implements Detector {
  async detect(text: string, rule: CorrectionRule): Promise<DetectorResult> {
    const start = Date.now();
    if (rule.detector.type !== 'keyword') {
      return { triggered: false, latencyMs: 0 };
    }

    const { words, matchAll } = rule.detector.config;
    const lowerText = text.toLowerCase();

    if (matchAll) {
      const triggered = words.every(w => lowerText.includes(w.toLowerCase()));
      return { triggered, latencyMs: Date.now() - start };
    }

    const triggered = words.some(w => lowerText.includes(w.toLowerCase()));
    return { triggered, latencyMs: Date.now() - start };
  }
}
