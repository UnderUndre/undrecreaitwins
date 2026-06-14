import { describe, it, expect } from 'vitest';
import { RegexDetector } from '../../services/correction-rules/detectors/regex-detector.js';
import { KeywordDetector } from '../../services/correction-rules/detectors/keyword-detector.js';
import { aggregate } from '../../services/correction-rules/aggregator.js';
import { wrapOperatorText } from '../../services/prompt-safety.js';
import type { CorrectionRule } from '../../services/correction-rules/types.js';

function makeRule(overrides: Partial<CorrectionRule> = {}): CorrectionRule {
  return {
    id: 'rule-1', tenantId: 't1', assistantId: 'a1', name: 'test',
    detector: { type: 'regex', config: { pattern: 'test' } },
    rewriteInstruction: 'fix it', mode: 'score', priority: 100,
    scope: 'full', turnScope: null, isEnabled: true, rubricItems: null,
    ...overrides,
  };
}

describe('RegexDetector', () => {
  it('triggers on pattern match', async () => {
    const d = new RegexDetector();
    const rule = makeRule({ detector: { type: 'regex', config: { pattern: 'em-dash' } } });
    const result = await d.detect('has em-dash here', rule);
    expect(result.triggered).toBe(true);
  });

  it('does not trigger when no match', async () => {
    const d = new RegexDetector();
    const rule = makeRule({ detector: { type: 'regex', config: { pattern: 'xyz' } } });
    const result = await d.detect('no match here', rule);
    expect(result.triggered).toBe(false);
  });

  it('handles invalid regex gracefully', async () => {
    const d = new RegexDetector();
    const rule = makeRule({ detector: { type: 'regex', config: { pattern: '[' } } });
    const result = await d.detect('text', rule);
    expect(result.triggered).toBe(false);
  });
});

describe('KeywordDetector', () => {
  it('triggers when any word found', async () => {
    const d = new KeywordDetector();
    const rule = makeRule({ detector: { type: 'keyword', config: { words: ['hello', 'world'] } } });
    const result = await d.detect('hello there', rule);
    expect(result.triggered).toBe(true);
  });

  it('triggers when all words found (matchAll)', async () => {
    const d = new KeywordDetector();
    const rule = makeRule({ detector: { type: 'keyword', config: { words: ['hello', 'world'], matchAll: true } } });
    expect((await d.detect('hello world', rule)).triggered).toBe(true);
    expect((await d.detect('hello only', rule)).triggered).toBe(false);
  });
});

describe('Aggregator', () => {
  it('sorts rewrite rules by priority', () => {
    const rules = [
      { rule: makeRule({ id: 'r1', mode: 'rewrite', priority: 50 }), triggered: true },
      { rule: makeRule({ id: 'r2', mode: 'rewrite', priority: 10 }), triggered: true },
    ];
    const result = aggregate(rules);
    expect(result.rewriteRules[0]!.id).toBe('r2');
    expect(result.rewriteRules[1]!.id).toBe('r1');
  });

  it('caps rewrite at 4', () => {
    const rules = Array.from({ length: 6 }, (_, i) => ({
      rule: makeRule({ id: `r${i}`, mode: 'rewrite', priority: i }),
      triggered: true,
    }));
    const result = aggregate(rules);
    expect(result.rewriteRules.length).toBe(4);
    expect(result.overflowSkipped.length).toBe(2);
  });

  it('separates score from rewrite', () => {
    const rules = [
      { rule: makeRule({ id: 'r1', mode: 'rewrite', priority: 1 }), triggered: true },
      { rule: makeRule({ id: 'r2', mode: 'score', priority: 1 }), triggered: true },
    ];
    const result = aggregate(rules);
    expect(result.rewriteRules.length).toBe(1);
    expect(result.scoreRules.length).toBe(1);
  });
});

describe('wrapOperatorText', () => {
  it('wraps text in delimited block', () => {
    const result = wrapOperatorText('be polite');
    expect(result).toContain('<operator_instructions>');
    expect(result).toContain('be polite');
  });

  it('truncates long text', () => {
    const long = 'x'.repeat(3000);
    const result = wrapOperatorText(long, 100);
    expect(result.length).toBeLessThan(long.length);
  });
});
