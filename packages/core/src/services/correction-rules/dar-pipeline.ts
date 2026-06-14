import type { LLMClient } from '../llm-client.js';
import { getRules } from './rule-cache.js';
import { pushEvents } from './event-push-client.js';
import { aggregate } from './aggregator.js';
import { rewrite } from './rewriter.js';
import { reValidate } from './re-validator.js';
import { RegexDetector } from './detectors/regex-detector.js';
import { KeywordDetector } from './detectors/keyword-detector.js';
import { PatternDetector, SemanticDetector } from './detectors/pattern-detector.js';
import type { CorrectionRule, DARResult, QualityEventPush, Detector } from './types.js';

const SEMANTIC_CONCURRENCY = parseInt(process.env.TWIN_DAR_SEMANTIC_CONCURRENCY || '3', 10);

let attemptCounter = 0;

export interface DARContext {
  tenantId: string;
  personaId: string;
  conversationId: string;
  messageId?: string;
  rawUserMessage?: string;
}

export async function execute(
  llm: LLMClient,
  text: string,
  context: DARContext,
): Promise<DARResult> {
  const start = Date.now();

  try {
    const { rules, snapshotVersion } = await getRules(context.tenantId, context.personaId);
    const enabledRules = rules.filter(r => r.isEnabled);

    if (enabledRules.length === 0) {
      return {
        text,
        events: [],
        latencyMs: Date.now() - start,
        stages: {
          detect: { triggered: 0, skipped: 0 },
          aggregate: { rewriteCapped: 0, overflowSkipped: 0 },
        },
      };
    }

    for (const rule of enabledRules) {
      if (rule.turnScope === 'conversation') {
        console.warn(`[DAR] turnScope=conversation not yet supported (rule ${rule.name}), treating as single-message`);
      }
    }

    const regexDetector = new RegexDetector();
    const keywordDetector = new KeywordDetector();
    const patternDetector = new PatternDetector(llm);
    const semanticDetector = new SemanticDetector(llm);

    const structuralRules = enabledRules.filter(r => r.detector.type === 'regex' || r.detector.type === 'keyword');
    const llmRules = enabledRules.filter(r => r.detector.type === 'pattern' || r.detector.type === 'semantic');

    const detectStart = Date.now(); void detectStart;
    const structuralResults = await Promise.all(
      structuralRules.map(async rule => {
        const detector = rule.detector.type === 'regex' ? regexDetector : keywordDetector;
        const result = await detector.detect(text, rule);
        return { rule, triggered: result.triggered };
      }),
    );

    const llmResults: Array<{ rule: CorrectionRule; triggered: boolean }> = [];
    for (let i = 0; i < llmRules.length; i += SEMANTIC_CONCURRENCY) {
      const batch = llmRules.slice(i, i + SEMANTIC_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async rule => {
          const detector: Detector = rule.detector.type === 'pattern' ? patternDetector : semanticDetector;
          const result = await detector.detect(text, rule);
          return { rule, triggered: result.triggered };
        }),
      );
      for (const s of settled) {
        if (s.status === 'fulfilled') llmResults.push(s.value);
      }
    }

    const allResults = [...structuralResults, ...llmResults];
    const triggeredCount = allResults.filter(r => r.triggered).length;

    const agg = aggregate(allResults);

    const events: QualityEventPush[] = [];
    const attempt = ++attemptCounter;

    for (const rule of agg.scoreRules) {
      events.push(makeEvent(rule, context, 'fail', text, undefined, false, snapshotVersion, attempt));
    }

    for (const rule of agg.overflowSkipped) {
      events.push(makeEvent(rule, context, 'overflow_skipped', text, undefined, false, snapshotVersion, attempt));
    }

    let deliveredText = text;

    if (agg.rewriteRules.length > 0) {
      const rewriteResult = await rewrite(llm, text, agg.rewriteRules, context.tenantId, context.personaId);

      if (rewriteResult && rewriteResult.text) {
        const reval = await reValidate(llm, text, rewriteResult.text, context);

        if (reval.passed) {
          deliveredText = rewriteResult.text;
          for (const rule of agg.rewriteRules) {
            events.push(makeEvent(rule, context, 'rewritten', text, rewriteResult.text, false, snapshotVersion, attempt));
          }
        } else {
          for (const rule of agg.rewriteRules) {
            events.push(makeEvent(rule, context, 'rolled_back', text, rewriteResult.text, true, snapshotVersion, attempt));
          }
        }
      } else {
        for (const rule of agg.rewriteRules) {
          events.push(makeEvent(rule, context, 'rolled_back', text, undefined, true, snapshotVersion, attempt));
        }
      }
    }

    if (events.length > 0) {
      setImmediate(() => {
        pushEvents(context.tenantId, events.filter(e => e.verdict !== 'fail'));
      });
      pushEvents(context.tenantId, events.filter(e => e.verdict === 'fail'));
    }

    return {
      text: deliveredText,
      events,
      latencyMs: Date.now() - start,
      stages: {
        detect: { triggered: triggeredCount, skipped: allResults.length - triggeredCount },
        aggregate: {
          rewriteCapped: agg.rewriteRules.length,
          overflowSkipped: agg.overflowSkipped.length,
        },
      },
    };
  } catch (err) {
    console.error({ err }, '[DAR] Pipeline error, failing open');
    return {
      text,
      events: [],
      latencyMs: Date.now() - start,
      stages: {
        detect: { triggered: 0, skipped: 0 },
        aggregate: { rewriteCapped: 0, overflowSkipped: 0 },
      },
    };
  }
}

function makeEvent(
  rule: CorrectionRule,
  context: DARContext,
  verdict: QualityEventPush['verdict'],
  originalText: string | undefined,
  rewrittenText: string | undefined,
  rolledBack: boolean,
  snapshotVersion: string,
  attempt: number,
): QualityEventPush {
  return {
    assistantId: rule.assistantId || context.personaId,
    ruleId: rule.id,
    ruleName: rule.name,
    conversationId: context.conversationId,
    messageId: context.messageId || null,
    mode: rule.mode,
    verdict,
    originalText: rule.mode === 'rewrite' ? originalText : undefined,
    rewrittenText: rule.mode === 'rewrite' ? rewrittenText : undefined,
    latencyMs: 0,
    rolledBack,
    idempotencyKey: `${context.messageId || 'noid'}:${rule.id}:${attempt}`,
    snapshotVersion,
  };
}
