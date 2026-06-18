import type { 
  FunnelFragment, 
  FunnelConfig, 
  ConversationFunnelState, 
  FunnelSelectionMetadata,
  FunnelStage,
  FullFunnel,
  FragmentDeliveryMode,
} from '@undrecreaitwins/shared';
import { FragmentScorer, ScoredFragment } from './scorer.js';
import { FunnelRepository } from './funnel-repository.js';
import { Redis } from 'ioredis';
import { evaluateDeliveryCondition } from './utils/condition-evaluator.js';
import { parseVariables } from './utils/variable-parser.js';
import { calculatePacing } from './utils/pacing.js';
import { AdaptiveIntroService } from '../llm/adaptive-intro.js';
import { IntentClassifier } from '../llm/intent-classifier.js';
import { SlotExtractorService } from '../llm/slot-extractor.js';
import { TurnMetrics } from './turn-metrics.js';
import { runOutputGuard, type OutputGuardResult } from '../llm/guards/output-guard.js';
import type { BannedWordsConfig } from '../llm/guards/banned-words.js';
import { checkAntiRepeat, type AntiRepeatResult } from '../llm/guards/anti-repeat.js';
import { contextualRetell } from '../llm/contextual-reteller.js';
import type { LLMClient } from '../llm-client.js';
import { db } from '../../db.js';
import { conversations, messages } from '../../models/index.js';
import { eq, desc } from 'drizzle-orm';

export interface FunnelProcessResult {
  scriptedReply?: string;
  metadata: FunnelSelectionMetadata;
  introPromise?: Promise<string | null>;
}

export class FunnelRuntime {
  private cache = new Map<string, FullFunnel>();
  private readonly CACHE_MAX_SIZE = 100;

  constructor(
    private repository: FunnelRepository,
    private scorerFactory: (config: FunnelConfig) => FragmentScorer,
    private redis?: Redis,
    private adaptiveIntroService?: AdaptiveIntroService,
    private intentClassifier?: IntentClassifier,
    private slotExtractor?: SlotExtractorService,
    private outputGuardConfig?: BannedWordsConfig,
    private regenerateFn?: (repairPrompt: string) => Promise<string>,
    private llmClient?: LLMClient,
    private embeddingFn?: (text: string) => Promise<number[]>,
  ) {}

  public async processMessage(
    tenantId: string,
    personaId: string,
    conversationId: string,
    message: string,
    remainingReruns: number = 2,
    metrics?: TurnMetrics,
    previousReply?: string,
    conversationHistory?: string[],
  ): Promise<FunnelProcessResult> {
    const lockKey = `lock:funnel:conv:${conversationId}`;
    let lockAcquired = false;

    if (this.redis) {
      const result = await this.redis.set(lockKey, 'locked', 'PX', 30000, 'NX');
      if (!result) {
        throw new Error('Concurrent request to funnel for this conversation');
      }
      lockAcquired = true;
    }

    try {
      // 1. Load conversation state
      let state = await this.repository.getConversationState(conversationId);
      
      // 2. Resolve funnel version
      let funnel: FullFunnel | null = null;

      if (!state) {
        // New conversation or first time funnel - use active version
        funnel = await this.repository.getActiveVersion(tenantId, personaId);
        if (!funnel || funnel.stages.length === 0) {
          return { metadata: { type: 'no_funnel', funnel: { type: 'no_funnel' } } };
        }

        const firstStage = funnel.stages[0];
        const newState: Omit<ConversationFunnelState, 'updatedAt'> = {
          conversationId,
          funnelVersionId: funnel!.id,
          currentStageId: firstStage!.id,
          consecutiveStuckCount: 0,
          capturedSlots: {},
          activeTopics: [],
          unresolvedObjections: [],
          messagesOnCurrentStage: 0,
          pendingStageOffer: null,
          version: 0,
          returnStack: []
        };
        await this.repository.createConversationState(newState as any);
        state = { ...newState, updatedAt: new Date() } as ConversationFunnelState;
      } else {
        funnel = await this.getFunnelWithCache(state.funnelVersionId);
      }

      if (!funnel || !state) {
        return { metadata: { type: 'no_funnel', funnel: { type: 'no_funnel' } } };
      }

      // NFR-6: Override metrics max values from actual funnel config
      if (metrics) {
        metrics.setLimits(
          funnel.config.maxTurnReruns ?? 2,
          funnel.config.maxTurnLLMCalls ?? 6,
        );
      }

      // 2.5. Affirmative Advance (017-hybrid-agent-core, task 4.8)
      const pendingOffer: string | null = state.pendingStageOffer;
      if (pendingOffer) {
        let affirmative: boolean;
        if (this.intentClassifier) {
          const result = await this.intentClassifier.classify(message, { tenantId, personaId, metrics });
          affirmative = result.affirmative;
          if (metrics) {
            metrics.stepFired('intent_classify');
            if (result.source === 'llm') metrics.recordLLMCall({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 1 });
          }
        } else {
          affirmative = this.detectAffirmative(message);
          if (metrics) metrics.stepSkipped('intent_classify', 'no_classifier');
        }
        if (affirmative) {
          const offeredStage = funnel.stages.find((s: FunnelStage) => s.name === pendingOffer);
          if (offeredStage) {
            // Route to offered stage
            await this.repository.updateConversationState(conversationId, {
              currentStageId: offeredStage.id,
              consecutiveStuckCount: 0,
              messagesOnCurrentStage: 0,
              pendingStageOffer: null,
            } as any, state.version);

            return {
              metadata: {
                type: 'affirmative_advance',
                funnel: {
                  type: 'affirmative_advance',
                  stage_transition: { from: state.currentStageId, to: offeredStage.id, type: 'advance' },
                },
              } as any,
            };
          }
        } else {
          // Non-affirmative response clears the offer
          await this.repository.updateConversationState(conversationId, {
            pendingStageOffer: null,
          } as any, state.version);
          // Re-read state after clearing offer
          state = await this.repository.getConversationState(conversationId) ?? state;
        }
      }

      // 2.6. Confirmation Gate (T025 — FR-014)
      const pendingConfStageId: string | null = state.pendingConfirmation;
      if (pendingConfStageId) {
        const pendingStage = funnel.stages.find((s: FunnelStage) => s.id === pendingConfStageId);
        if (pendingStage) {
          let affirmative: boolean;
          if (this.intentClassifier) {
            const result = await this.intentClassifier.classify(message, { tenantId, personaId, metrics });
            affirmative = result.affirmative;
            if (metrics) {
              metrics.stepFired('intent_classify');
              if (result.source === 'llm') metrics.recordLLMCall({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 1 });
            }
          } else {
            affirmative = this.detectAffirmative(message);
            if (metrics) metrics.stepSkipped('intent_classify', 'no_classifier');
          }
          if (affirmative) {
            // User confirmed — advance to pending stage
            await this.repository.updateConversationState(conversationId, {
              currentStageId: pendingStage.id,
              consecutiveStuckCount: 0,
              messagesOnCurrentStage: 0,
              pendingConfirmation: null,
            } as any, state.version);
            return {
              metadata: {
                type: 'scripted',
                funnel: {
                  type: 'scripted',
                  fragment_id: '',
                  delivery_mode: 'llm',
                  stage_transition: { from: state.currentStageId, to: pendingStage.id, type: 'advance' },
                },
              },
            };
          } else {
            // Non-affirmative — stay on current stage, clear pending
            await this.repository.updateConversationState(conversationId, {
              pendingConfirmation: null,
            } as any, state.version);
            state = await this.repository.getConversationState(conversationId) ?? state;
          }
        }
      }

      // 2.7. Anytime Trigger Detection (T026 — FR-015)
      const currentStageForAnytime = funnel.stages.find((s: FunnelStage) => s.id === state!.currentStageId);
      if (currentStageForAnytime) {
        const anytimeStages = funnel.stages
          .filter((s: FunnelStage) => s.isAnytime && s.anytimeTriggers && s.anytimeTriggers.length > 0)
          .sort((a: FunnelStage, b: FunnelStage) => a.order - b.order);

        for (const anytimeStage of anytimeStages) {
          // Self-trigger: current stage is the anytime stage → no-op
          if (anytimeStage.id === state!.currentStageId) continue;

          // Duplicate prevention: already in returnStack → no-op
          const returnStack: string[] = state.returnStack ?? [];
          if (returnStack.includes(anytimeStage.id)) continue;

          const triggered = this.detectAnytimeTrigger(message, anytimeStage, returnStack.length);
          if (triggered) {
            if (metrics) metrics.stepFired('anytime_trigger');
            // Max depth check
            if (returnStack.length >= 3) {
              // Reject — stay on current, log
              continue;
            }
            // Push current to returnStack, switch to anytime stage
            const newStack = [...returnStack, state!.currentStageId];
            await this.repository.updateConversationState(conversationId, {
              currentStageId: anytimeStage.id,
              returnStack: newStack,
              consecutiveStuckCount: 0,
              messagesOnCurrentStage: 0,
            } as any, state.version);
            return {
              metadata: {
                type: 'scripted',
                funnel: {
                  type: 'scripted',
                  fragment_id: '',
                  delivery_mode: 'llm',
                  stage_transition: { from: state!.currentStageId, to: anytimeStage.id, type: 'advance' },
                },
              },
            };
          }
        }
      }

      // 3. Scoring
      const currentStage = funnel.stages.find((s: FunnelStage) => s.id === state!.currentStageId);
      const nextStage = funnel.stages.find((s: FunnelStage) => s.order === (currentStage?.order ?? 0) + 1);

      // 3.1. Filter fragments by delivery condition (US15)
      const slotsMap = Object.fromEntries(
        Object.entries(state.capturedSlots).map(([k, v]) => [k, v.value])
      );
      // Also include global conversation slots (FR-012)
      const globalSlots: Record<string, unknown> = (state as Record<string, unknown>).slots ?? {};
      const allSlots = { ...globalSlots, ...slotsMap };

      const allFragments = funnel.stages.flatMap((s: any) => s.fragments);
      const eligibleFragments = allFragments.filter(f => 
        evaluateDeliveryCondition(f.deliveryCondition, allSlots)
      );

      const scorer = this.scorerFactory(funnel.config);
      const scoredFragments = scorer.score(message, eligibleFragments, {
        currentStageId: state!.currentStageId,
        nextStageId: nextStage?.id,
        isObjectionDetected: false, // TODO: Simple objection detection
      });

      // Sort by score DESC, then by ID (tiebreak)
      const sorted = scoredFragments.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.fragment.id.localeCompare(b.fragment.id);
      });

      const best = sorted[0];
      const selectionMetadata: FunnelSelectionMetadata = { 
        type: 'no_funnel',
        funnel: { type: 'no_funnel' }
      };

      // 2.8. Anytime Stage Resolution → Pop LIFO (T026 — FR-015)
      if (currentStageForAnytime?.isAnytime) {
        const returnStack: string[] = state.returnStack ?? [];
        if (returnStack.length > 0) {
          const resolved = this.checkResolutionCriteria(currentStageForAnytime, state!, funnel, best);
          if (resolved) {
            let poppedId = returnStack[returnStack.length - 1];
            const newStack = returnStack.slice(0, -1);
            while (poppedId && !funnel.stages.find((s: FunnelStage) => s.id === poppedId)) {
              poppedId = newStack.pop();
            }
            if (poppedId) {
              await this.repository.updateConversationState(conversationId, {
                currentStageId: poppedId,
                returnStack: newStack,
              } as any, state.version);
              return {
                metadata: {
                  type: 'scripted',
                  funnel: {
                    type: 'scripted',
                    fragment_id: '',
                    delivery_mode: 'llm',
                    stage_transition: { from: currentStageForAnytime.id, to: poppedId, type: 'advance' },
                  },
                },
              };
            }
          }
        }
      }

      // 4. Threshold Check & Reply Selection
      let scriptedReply: string | undefined;
      let effectiveDeliveryMode: FragmentDeliveryMode = 'llm';

      if (best && best.score >= funnel.config.relevance_threshold) {
        const fragment = best.fragment;
        const deliveryMode: FragmentDeliveryMode = fragment.deliveryMode || 'llm';
        effectiveDeliveryMode = deliveryMode;

        if (deliveryMode === 'verbatim') {
          scriptedReply = fragment.content;
        } else if (deliveryMode === 'template') {
          const parsed = parseVariables(fragment.content, { slots: allSlots });
          scriptedReply = parsed.text;
          // TODO: Log unresolved variables if needed
        } else {
          // 'llm' mode - content is used as instruction for LLM downstream
          scriptedReply = fragment.content;
        }

        selectionMetadata.type = 'scripted';
        selectionMetadata.funnel = {
          type: 'scripted',
          fragment_id: best.fragment.id,
          delivery_mode: deliveryMode,
          score: best.score,
          signals: best.signals,
        };
      } else {
        const behavior = funnel.config.off_script_behavior;
        if (behavior === 'catch_all' && funnel.config.catch_all_fragment_id) {
          const catchAll = allFragments.find((f: FunnelFragment) => f.id === funnel!.config.catch_all_fragment_id);
          if (catchAll) {
            scriptedReply = catchAll.content;
            selectionMetadata.type = 'catch_all';
            selectionMetadata.funnel = {
              type: 'catch_all',
              fragment_id: catchAll.id,
              delivery_mode: catchAll.deliveryMode || 'llm',
            };
          }
        } else {
          const type = behavior === 'abstain' ? 'abstain' : 'steer';
          selectionMetadata.type = type;
          selectionMetadata.funnel = {
            type: type,
            score: best?.score,
          };
        }
      }

      // 5. Transition Logic & Stuck Safety
      if (currentStage) {
        const transition = await this.evaluateTransitions(state, funnel, currentStage, best);
        
        let updatedStuckCount = state.consecutiveStuckCount;
        let updatedMsgsOnStage = state.messagesOnCurrentStage ?? 0;
        updatedMsgsOnStage++; // Increment per message (task 4.6)

        // ── Stage Advance Guard (computed ONCE, reused) ──
        const targetForGuard = transition.type !== 'stay'
          ? funnel.stages.find((s: FunnelStage) => s.id === transition.to)
          : undefined;
        const skipGuard = targetForGuard?.requiresConfirmation === true;
        const advanceGuard = (transition.type !== 'stay' && !skipGuard)
          ? this.evaluateAdvanceGuard(state, currentStage, message)
          : { blocked: false };

        if (transition.type === 'stay' || advanceGuard.blocked) {
          updatedStuckCount++;
        } else {
          updatedStuckCount = 0;
          updatedMsgsOnStage = 0; // Reset on stage advance (task 4.6)
        }

        const stuckAction = this.handleStuck(updatedStuckCount, currentStage, funnel.config);
        
        const update: Partial<ConversationFunnelState> = {
          consecutiveStuckCount: updatedStuckCount,
          messagesOnCurrentStage: updatedMsgsOnStage,
        };

        if (transition.type !== 'stay' && !advanceGuard.blocked) {
          // T025: Confirmation Gate — intercept advance to requiresConfirmation stage
          const targetStage = funnel.stages.find((s: FunnelStage) => s.id === transition.to);
          if (targetStage?.requiresConfirmation) {
            const confirmationPrompt = this.buildConfirmationPrompt(targetStage, allSlots);
            await this.repository.updateConversationState(conversationId, {
              pendingConfirmation: targetStage.id,
            } as any, state.version);
            return {
              scriptedReply: confirmationPrompt,
              metadata: {
                type: 'scripted',
                funnel: {
                  type: 'scripted',
                  fragment_id: '',
                  delivery_mode: 'llm',
                  stage_transition: { from: state.currentStageId, to: targetStage.id, type: 'advance' },
                },
              },
            };
          }
          update.currentStageId = transition.to;
          if (selectionMetadata.funnel) {
            selectionMetadata.funnel.stage_transition = transition;
          }
        } else if (advanceGuard.blocked) {
          // Guard blocked the transition — metadata reflects block
          if (selectionMetadata.funnel) {
            selectionMetadata.funnel.stage_transition = {
              ...transition,
              blocked: true,
              blockedReason: advanceGuard.reason ?? 'advance_guard',
            };
          }
        }

        if (stuckAction) {
          if (stuckAction === 'exit_stage' && currentStage.exitStageId) {
              update.currentStageId = currentStage.exitStageId;
              update.consecutiveStuckCount = 0;
              if (selectionMetadata.funnel) {
                selectionMetadata.funnel.stage_transition = {
                    from: currentStage.id,
                    to: currentStage.exitStageId,
                    type: 'advance'
                };
              }
          }
        }

        await this.repository.updateConversationState(conversationId, update, state.version);
      }

      // 5.5 Output guard — FR-022 (skip verbatim: banned words don't apply)
      let outputGuardResult: OutputGuardResult | undefined;
      if (
        scriptedReply &&
        effectiveDeliveryMode !== 'verbatim' &&
        this.outputGuardConfig &&
        this.regenerateFn &&
        metrics?.hasRerunBudget() === true
      ) {
        if (metrics) metrics.stepFired('banned_check');
        outputGuardResult = await runOutputGuard({
          reply: scriptedReply,
          config: this.outputGuardConfig,
          remainingReruns,
          regenerateFn: this.regenerateFn,
        });
        scriptedReply = outputGuardResult.reply;
        if (outputGuardResult.blocked) {
          (selectionMetadata as any).blocked_by_guard = 'output_guard';
        }
        if (outputGuardResult.warnings.length > 0) {
          (selectionMetadata as any).guard_warnings = outputGuardResult.warnings;
        }
      }

      // 5.6 Anti-repeat guard — T028 / FR-016 (skip verbatim: verbatim is always same by design)
      let antiRepeatResult: AntiRepeatResult | undefined;
      if (
        scriptedReply &&
        effectiveDeliveryMode !== 'verbatim' &&
        this.embeddingFn &&
        this.regenerateFn &&
        metrics?.hasRerunBudget()
      ) {
        if (metrics) metrics.stepFired('anti_repeat');
        antiRepeatResult = await checkAntiRepeat({
          currentReply: scriptedReply,
          previousReply,
          embeddingFn: this.embeddingFn,
          regenerateFn: this.regenerateFn,
          remainingReruns: metrics ? metrics.rerunsRemaining : remainingReruns,
        });
        scriptedReply = antiRepeatResult.reply;
        if (antiRepeatResult.rerunTriggered) {
          metrics?.recordRerun();
          (selectionMetadata as any).anti_repeat_rerun = true;
        }
      } else if (scriptedReply && metrics) {
        metrics.stepSkipped('anti_repeat', !this.embeddingFn ? 'no_embedding_fn' : 'budget_or_verbatim');
      }

      // 5.7 Contextual retell — T029 / FR-017 (skip first visit + verbatim)
      const stageTransition = (selectionMetadata.funnel as any)?.stage_transition;
      const isRevisit = !!stageTransition && stageTransition.from !== stageTransition.to;
      if (
        scriptedReply &&
        this.llmClient &&
        metrics?.hasRerunBudget()
      ) {
        const history = conversationHistory ?? await this.loadConversationHistory(conversationId, tenantId);
        const retellResult = await contextualRetell({
          fragmentContent: scriptedReply,
          deliveryMode: effectiveDeliveryMode,
          conversationHistory: history,
          isRevisit,
          llmClient: this.llmClient,
          tenantId,
          personaId,
          remainingReruns: metrics ? metrics.rerunsRemaining : remainingReruns,
          metrics,
        });
        scriptedReply = retellResult.text;
        if (retellResult.retellTriggered) {
          metrics?.recordRerun();
          (selectionMetadata as any).contextual_retell = true;
        }
      } else if (scriptedReply && metrics) {
        metrics.stepSkipped('contextual_retell', !this.llmClient ? 'no_llm_client' : 'budget_exhausted');
      }

      // 6. Humanization metadata (020-engine-funnel-richness)
      if (scriptedReply) {
        selectionMetadata.humanization = calculatePacing({ content: scriptedReply });
      }

      // 7. Post-turn slot extraction (FR-010, FR-012)
      // Runs under conversation lock, BEFORE lock release, BEFORE turn-done.
      // Lock must remain held during extraction — next turn sees fresh slots.
      if (scriptedReply && this.slotExtractor && funnel.slots.length > 0 && metrics?.hasLLMBudget() !== false) {
        if (metrics) metrics.stepFired('slot_extraction');
        try {
          const allSlotDefs = funnel.slots;
          const lockedSlotNames = allSlotDefs.filter(s => s.locked).map(s => s.name);

          const convoRow = await db.select({ slots: conversations.slots })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .limit(1);

          const convoSlots: Record<string, unknown> = (convoRow[0]?.slots as Record<string, unknown>) ?? {};

          const extraction = await this.slotExtractor.extractSlots({
            userMessage: message,
            assistantReply: scriptedReply,
            slotDefinitions: allSlotDefs,
            conversationSlots: convoSlots,
            tenantId,
            personaId,
            metrics,
          });

          if (Object.keys(extraction.extracted).length > 0) {
            await this.repository.mergeConversationSlots(
              conversationId,
              extraction.extracted,
              lockedSlotNames,
            );
          }
        } catch {
          // NFR-2: extraction failure → slots unchanged, reply sent normally
        }
      }

      return { scriptedReply, metadata: selectionMetadata };
    } finally {
      if (lockAcquired && this.redis) {
        await this.redis.del(lockKey);
      }
    }
  }

  /**
   * Affirmative Advance detection (017-hybrid-agent-core, task 4.8)
   * Uses word-boundary matching with Cyrillic-safe split (not \b which doesn't work for Cyrillic).
   * Returns true if user message is affirmative.
   */
  private detectAffirmative(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    const words = normalized.split(/[\s,.!?;:]+/).filter(Boolean);

    // Negation guard — if negation pattern found, NOT affirmative
    const negationWords = ['не', 'нет', 'никогда', 'отказываюсь'];
    const negationPhrases = ['не хочу', 'не надо', 'не нужно', 'не буду', 'не думаю', 'не планирую', 'не собираюсь'];
    if (negationPhrases.some(p => normalized.includes(p))) return false;

    // Word-level match (avoids false positives like "когда" containing "да")
    const affirmativeWords = new Set([
      'да', 'давайте', 'давай', 'ок', 'окей', 'хорошо',
      'согласен', 'согласна', 'согласны', 'хочу', 'готов', 'готова', 'готовы',
      'конечно', 'точно', 'офк', 'угу', 'ага', 'поехали',
      'yes', 'sure', 'ok', 'okay', "let's", 'please', 'yep', 'yeah',
    ]);

    return words.some(w => affirmativeWords.has(w));
  }

  /**
   * Stage Advance Guard (017-hybrid-agent-core, task 4.7)
   * Deterministic gate evaluated BEFORE any LLM-proposed stage transition.
   * Returns { blocked: boolean, reason?: string }
   */
  private evaluateAdvanceGuard(
    state: ConversationFunnelState,
    currentStage: FunnelStage,
    userMessage: string
  ): { blocked: boolean; reason?: string } {
    // (1) Unresolved objections → BLOCK
    const unresolvedObjections: string[] = state.unresolvedObjections ?? [];
    if (unresolvedObjections.length > 0) {
      return { blocked: true, reason: 'unresolved_objections' };
    }

    // (2) Min messages on stage not reached → BLOCK
    const msgsOnStage: number = state.messagesOnCurrentStage ?? 0;
    const minMessages: number = (currentStage as { minMessages?: number }).minMessages ?? 1;
    if (msgsOnStage < minMessages) {
      return { blocked: true, reason: 'min_messages' };
    }

    // (3) Last user message is a question → BLOCK unless buying-intent
    const BUYING_INTENT_KEYWORDS = [
      'купить', 'оплатить', 'сколько стоит', 'как оплатить',
      'где платить', 'оформить', 'цена', 'стоимость', 'заказать',
      'buy', 'purchase', 'price', 'pay', 'order', 'checkout',
    ];
    const isQuestion = userMessage.trim().endsWith('?')
      || /^(как|что|где|когда|почему|сколько|зачем|кто|какой|который)\b/i.test(userMessage.trim())
      || /^(how|what|where|when|why|how much|who|which)\b/i.test(userMessage.trim());

    if (isQuestion) {
      const hasBuyingIntent = BUYING_INTENT_KEYWORDS.some(kw =>
        userMessage.toLowerCase().includes(kw)
      );
      if (!hasBuyingIntent) {
        return { blocked: true, reason: 'user_question' };
      }
    }

    // (4) Topic continues in current stage → BLOCK
    const activeTopics: string[] = state.activeTopics ?? [];
    const stageSlotNames: string[] = currentStage.requiredSlots ?? [];
    if (activeTopics.length > 0 && stageSlotNames.length > 0) {
      const overlap = activeTopics.some(t =>
        stageSlotNames.some(s => s.toLowerCase() === t.toLowerCase())
      );
      if (overlap) {
        return { blocked: true, reason: 'topic_continues' };
      }
    }

    // (5) Required slots not filled → BLOCK (T023)
    if (stageSlotNames.length > 0) {
      const globalSlots: Record<string, unknown> = (state as Record<string, unknown>).slots ?? {};
      const capturedSlots = state.capturedSlots ?? {};
      const missingSlots = stageSlotNames.filter(slotName => {
        const fromGlobal = globalSlots[slotName];
        if (fromGlobal !== undefined && fromGlobal !== null && fromGlobal !== '') return false;
        const fromCaptured = capturedSlots[slotName];
        if (fromCaptured && fromCaptured.value !== undefined && fromCaptured.value !== null && fromCaptured.value !== '') return false;
        return true;
      });
      if (missingSlots.length > 0) {
        return { blocked: true, reason: 'required_slots' };
      }
    }

    return { blocked: false };
  }

  private async evaluateTransitions(
    state: ConversationFunnelState,
    funnel: FullFunnel,
    currentStage: FunnelStage,
    best?: ScoredFragment
  ): Promise<{ from: string; to: string; type: 'advance' | 'regression' | 'stay' }> {
    const stay = { from: currentStage.id, to: currentStage.id, type: 'stay' as const };

    const criteria = currentStage.resolutionCriteria;
    let resolved = false;

    if (criteria.type === 'fragment_selected' && best?.fragment.id === criteria.fragment_id) {
      resolved = true;
    } else if (criteria.type === 'slot_filled' && state.capturedSlots[criteria.slot_name]?.verified) {
      resolved = true;
    } else if (criteria.type === 'all_slots_filled') {
      const stageSlots = funnel.slots.filter(s => s.stageId === currentStage.id);
      resolved = stageSlots.every(s => state.capturedSlots[s.name]?.verified);
    }

    if (resolved && currentStage.nextStageId) {
      return { from: currentStage.id, to: currentStage.nextStageId, type: 'advance' };
    }

    if (best && best.fragment.stageId !== currentStage.id) {
        const bestStage = funnel.stages.find((s: any) => s.id === best.fragment.stageId);
        if (bestStage && bestStage.order < currentStage.order) {
            return { from: currentStage.id, to: bestStage.id, type: 'regression' };
        }
    }

    return stay;
  }

  private handleStuck(
    stuckCount: number,
    stage: FunnelStage,
    config: FunnelConfig
  ): 'yield_generation' | 'handoff' | 'exit_stage' | null {
    if (stuckCount >= config.stuck_threshold) {
      return stage.stuckAction || config.stuck_action;
    }
    return null;
  }

  /**
   * T025 — Build confirmation prompt with slot values substituted.
   * Uses stage's confirmationPrompt template, or generates a default.
   */
  private buildConfirmationPrompt(stage: FunnelStage, allSlots: Record<string, unknown>): string {
    const template = (stage as any).confirmationPrompt;
    if (template) {
      const result = parseVariables(template, { slots: allSlots });
      return result.text;
    }
    // Default confirmation prompt
    return `Подтвердите переход на этап "${stage.name}"?`;
  }

  /**
   * T026 — Detect anytime trigger via hybrid: regex fast-path → LLM fallback.
   * Returns true if the user message triggers the anytime stage.
   */
  private detectAnytimeTrigger(
    message: string,
    stage: FunnelStage,
    currentStackDepth: number
  ): boolean {
    const triggers = (stage as any).anytimeTriggers as string[] | undefined;
    if (!triggers || triggers.length === 0) return false;

    // Max depth check (reject 4th push)
    if (currentStackDepth >= 3) return false;

    // Fast-path: keyword/regex
    const normalized = message.trim().toLowerCase();
    const matched = triggers.some(trigger => normalized.includes(trigger.toLowerCase()));
    if (matched) return true;

    // LLM fallback (budget-aware: consumes maxTurnLLMCalls if available)
    // For now, rely on regex. LLM fallback can be wired via intentClassifier
    // with a dedicated "anytime trigger" prompt in a future iteration.
    return false;
  }

  /**
   * T026 — Check if an anytime stage's resolution criteria are met.
   */
  private checkResolutionCriteria(
    stage: FunnelStage,
    state: ConversationFunnelState,
    funnel: FullFunnel,
    best?: ScoredFragment
  ): boolean {
    const criteria = stage.resolutionCriteria;
    if (criteria.type === 'fragment_selected' && best?.fragment.id === criteria.fragment_id) {
      return true;
    }
    if (criteria.type === 'slot_filled' && state.capturedSlots[criteria.slot_name]?.verified) {
      return true;
    }
    if (criteria.type === 'all_slots_filled') {
      const stageSlots = funnel.slots.filter(s => s.stageId === stage.id);
      return stageSlots.every(s => state.capturedSlots[s.name]?.verified);
    }
    return false;
  }

  /**
   * Load recent conversation history (last 10 messages) for contextual retell.
   * Returns alternating User/Bot lines.
   */
  private async loadConversationHistory(conversationId: string, tenantId: string): Promise<string[]> {
    try {
      const rows = await db.select({ role: messages.role, content: messages.content })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(eq(conversations.id, conversationId))
        .where(eq(conversations.tenantId, tenantId))
        .orderBy(desc(messages.createdAt))
        .limit(10);

      return rows.reverse().map(r => r.content);
    } catch {
      return [];
    }
  }

  private async getFunnelWithCache(versionId: string): Promise<FullFunnel | null> {
    if (this.cache.has(versionId)) {
      return this.cache.get(versionId)!;
    }

    const funnel = await this.repository.getFullVersion(versionId);
    if (funnel) {
      if (this.cache.size >= this.CACHE_MAX_SIZE) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) this.cache.delete(firstKey);
      }
      this.cache.set(versionId, funnel);
    }
    return funnel;
  }
}
