import type { 
  FunnelFragment, 
  FunnelConfig, 
  ConversationFunnelState, 
  FunnelSelectionMetadata,
  FunnelStage,
  FullFunnel,
} from '@undrecreaitwins/shared';
import { FragmentScorer, ScoredFragment } from './scorer.js';
import { FunnelRepository } from './funnel-repository.js';
import Redis from 'ioredis';

export class FunnelRuntime {
  private cache = new Map<string, FullFunnel>();
  private readonly CACHE_MAX_SIZE = 100;

  constructor(
    private repository: FunnelRepository,
    private scorerFactory: (config: FunnelConfig) => FragmentScorer,
    private redis?: Redis
  ) {}

  public async processMessage(
    tenantId: string,
    personaId: string,
    conversationId: string,
    message: string
  ): Promise<{ scriptedReply?: string; metadata: FunnelSelectionMetadata }> {
    const lockKey = `lock:funnel:conv:${conversationId}`;
    let lockAcquired = false;

    if (this.redis) {
      const result = await this.redis.set(lockKey, 'locked', 'PX', 10000, 'NX');
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
          return { metadata: { type: 'no_funnel' } };
        }

        const firstStage = funnel.stages[0];
        const newState: Omit<ConversationFunnelState, 'updatedAt'> = {
          conversationId,
          funnelVersionId: funnel!.id,
          currentStageId: firstStage!.id,
          consecutiveStuckCount: 0,
          capturedSlots: {},
          version: 0
        };
        await this.repository.createConversationState(newState as any);
        state = { ...newState, updatedAt: new Date() } as ConversationFunnelState;
      } else {
        funnel = await this.getFunnelWithCache(state.funnelVersionId);
      }

      if (!funnel || !state) {
        return { metadata: { type: 'no_funnel' } };
      }

      // 3. Scoring
      const currentStage = funnel.stages.find((s: FunnelStage) => s.id === state!.currentStageId);
      const nextStage = funnel.stages.find((s: FunnelStage) => s.order === (currentStage?.order ?? 0) + 1);

      const scorer = this.scorerFactory(funnel.config);
      const scoredFragments = scorer.score(message, funnel.stages.flatMap((s: any) => s.fragments), {
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
      const selectionMetadata: FunnelSelectionMetadata = { type: 'no_funnel' };

      // 4. Threshold Check & Reply Selection
      let scriptedReply: string | undefined;

      if (best && best.score >= funnel.config.relevance_threshold) {
        scriptedReply = best.fragment.content;
        selectionMetadata.type = 'scripted';
        selectionMetadata.fragment_id = best.fragment.id;
        selectionMetadata.score = best.score;
        selectionMetadata.signals = best.signals;
      } else {
        const behavior = funnel.config.off_script_behavior;
        if (behavior === 'catch_all' && funnel.config.catch_all_fragment_id) {
          const catchAll = funnel.stages.flatMap((s: any) => s.fragments).find((f: FunnelFragment) => f.id === funnel!.config.catch_all_fragment_id);
          if (catchAll) {
            scriptedReply = catchAll.content;
            selectionMetadata.type = 'catch_all';
            selectionMetadata.fragment_id = catchAll.id;
          }
        } else {
          selectionMetadata.type = behavior === 'abstain' ? 'abstain' : 'steer';
          selectionMetadata.score = best?.score;
        }
      }

      // 5. Transition Logic & Stuck Safety
      if (currentStage) {
        const transition = await this.evaluateTransitions(state, funnel, currentStage, best);
        
        let updatedStuckCount = state.consecutiveStuckCount;
        if (transition.type === 'stay') {
          updatedStuckCount++;
        } else {
          updatedStuckCount = 0;
        }

        const stuckAction = this.handleStuck(updatedStuckCount, currentStage, funnel.config);
        
        const update: Partial<ConversationFunnelState> = {
          consecutiveStuckCount: updatedStuckCount,
        };

        if (transition.type !== 'stay') {
          update.currentStageId = transition.to;
          selectionMetadata.stage_transition = transition;
        }

        if (stuckAction) {
          if (stuckAction === 'exit_stage' && currentStage.exitStageId) {
              update.currentStageId = currentStage.exitStageId;
              update.consecutiveStuckCount = 0;
              selectionMetadata.stage_transition = {
                  from: currentStage.id,
                  to: currentStage.exitStageId,
                  type: 'advance'
              };
          }
        }

        await this.repository.updateConversationState(conversationId, update, state.version);
      }

      return { scriptedReply, metadata: selectionMetadata };
    } finally {
      if (lockAcquired && this.redis) {
        await this.redis.del(lockKey);
      }
    }
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
