import { ValidatorPipeline } from '../validators/pipeline.js';
import { execute as darExecute } from './dar-pipeline.js';
import { pushEvents } from './event-push-client.js';
import type { LLMClient } from '../llm-client.js';
import type { QualityEventPush } from './types.js';
import type { QualityVerdict } from '../../types/quality-event.js';
import type { VerdictCoarse } from '../../types/quality.js';

export type GuardTier = 'full' | 'deterministic-only';

export interface GuardRunOptions {
  tier?: GuardTier;
}

export interface GuardContext {
  conversationId: string;
  messageId?: string;
  tenantId: string;
  personaId: string;
  rawUserMessage?: string;
  resolvedTargetLanguage?: string;
  systemPrompt?: string;
  regenerateFn?: (reinforcedSystemPrompt: string) => Promise<string>;
  degradeToAsIs?: boolean;
}

export interface GuardResult {
  response: string;
  events: QualityEventPush[];
  latencyMs: number;
  llmCallCount: number;
}

const SYSTEM_VERDICT_MAP: Record<VerdictCoarse, QualityVerdict> = {
  pass: 'pass',
  block: 'block',
  warn: 'fail',
  corrected: 'rewritten',
};

export class ResponseGuard {
  private validatorPipeline: ValidatorPipeline;
  private llm: LLMClient;
  private _llmCallCount = 0;

  constructor(llm: LLMClient) {
    this.validatorPipeline = new ValidatorPipeline(llm);
    this.llm = llm;
  }

  get llmCallCount(): number {
    return this._llmCallCount;
  }

  async run(
    response: string,
    ctx: GuardContext,
    options?: GuardRunOptions,
  ): Promise<GuardResult> {
    const startTime = Date.now();
    const originalResponse = response;
    let currentResponse = response;
    const tier = options?.tier ?? 'full';
    const allEvents: QualityEventPush[] = [];
    this._llmCallCount = 0;
    let shortCircuited = false;

    try {
      // Stage 1: System validators
      const valStart = Date.now();
      currentResponse = await this.validatorPipeline.validateResponse(currentResponse, {
        tenantId: ctx.tenantId,
        personaId: ctx.personaId,
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        rawUserMessage: ctx.rawUserMessage,
        resolvedTargetLanguage: ctx.resolvedTargetLanguage,
        systemPrompt: ctx.systemPrompt,
        regenerateFn: ctx.regenerateFn ? (async (prompt) => {
          this._llmCallCount++;
          return ctx.regenerateFn!(prompt);
        }) : undefined,
        degradeToAsIs: ctx.degradeToAsIs,
      });
      const valLatency = Date.now() - valStart;

      // T011: Emit system-validator event
      const systemChanged = currentResponse !== originalResponse;
      const sysVerdict: VerdictCoarse = systemChanged ? 'corrected' : 'pass';
      const systemEvent: QualityEventPush = {
        ts: new Date(),
        assistantId: ctx.personaId,
        ruleId: 'system-validators',
        ruleName: 'System Validators',
        conversationId: ctx.conversationId,
        messageId: ctx.messageId ?? null,
        mode: 'rewrite',
        verdict: SYSTEM_VERDICT_MAP[sysVerdict],
        originalText: systemChanged ? originalResponse : undefined,
        rewrittenText: systemChanged ? currentResponse : undefined,
        latencyMs: valLatency,
        rolledBack: false,
        idempotencyKey: `${ctx.conversationId}-${ctx.messageId ?? '?'}-system`,
        snapshotVersion: '',
      };
      allEvents.push(systemEvent);
      pushEvents(ctx.tenantId, [systemEvent]);

      // T010: shortCircuit — T034: system validators are terminal (block/rewrite)
      if (systemChanged) {
        shortCircuited = true;
      }

      // Stage 2: Custom rules (DAR)
      if (tier === 'full' && !shortCircuited) {
        const darResult = await darExecute(this.llm, currentResponse, {
          tenantId: ctx.tenantId,
          personaId: ctx.personaId,
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
          rawUserMessage: ctx.rawUserMessage,
        });

        if (darResult.text !== currentResponse) {
          currentResponse = darResult.text;
        }

        for (const event of darResult.events) {
          allEvents.push(event);
        }

        // Note: darExecute already pushes its events internally, so we do not call pushEvents here to avoid duplicates.
      }

      return {
        response: currentResponse,
        events: allEvents,
        latencyMs: Date.now() - startTime,
        llmCallCount: this._llmCallCount,
      };
    } catch (err) {
      console.error({ err }, '[ResponseGuard] Run failed, failing open');
      return {
        response,
        events: allEvents,
        latencyMs: Date.now() - startTime,
        llmCallCount: this._llmCallCount,
      };
    }
  }
}

export const USE_RESPONSE_GUARD = process.env.USE_RESPONSE_GUARD === 'true';
