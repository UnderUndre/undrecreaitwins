import type { CorrectionRule, AggregatorOutput } from './types.js';

export function aggregate(
  triggeredResults: Array<{ rule: CorrectionRule; triggered: boolean }>,
): AggregatorOutput {
  const rewriteTriggered: CorrectionRule[] = [];
  const scoreTriggered: CorrectionRule[] = [];

  for (const { rule, triggered } of triggeredResults) {
    if (!triggered) continue;
    if (!rule.isEnabled) continue;

    if (rule.mode === 'rewrite') {
      rewriteTriggered.push(rule);
    } else {
      scoreTriggered.push(rule);
    }
  }

  rewriteTriggered.sort((a, b) => a.priority - b.priority);

  const REWRITE_CAP = 4;
  const rewriteRules = rewriteTriggered.slice(0, REWRITE_CAP);
  const overflowSkipped = rewriteTriggered.slice(REWRITE_CAP);

  return {
    rewriteRules,
    scoreRules: scoreTriggered,
    overflowSkipped,
  };
}
