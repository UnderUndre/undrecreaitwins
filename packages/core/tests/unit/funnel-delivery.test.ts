import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FunnelRuntime } from '../../src/services/funnel/funnel-runtime.js';
import { FunnelRepository } from '../../src/services/funnel/funnel-repository.js';
import { Redis } from 'ioredis';
import type { FullFunnel, FunnelFragment, FunnelStage } from '@undrecreaitwins/shared';

describe('FunnelRuntime Delivery Cascade', () => {
  let repository: any;
  let scorerFactory: any;
  let scorer: any;
  let runtime: FunnelRuntime;
  let redis: any;

  const mockFunnel: FullFunnel = {
    id: 'f1',
    definitionId: 'def1',
    versionNumber: 1,
    isActive: true,
    createdAt: new Date(),
    config: {
      relevance_threshold: 0.5,
      off_script_behavior: 'steer',
      stuck_threshold: 3,
      stuck_action: 'handoff',
      scoring_weights: {
        exact_match: 1,
        stemmed_match: 1,
        synonym_match: 1,
        stage_boost: 1,
        next_stage_bonus: 1,
        objection_boost: 1
      }
    },
    stages: [
      {
        id: 's1',
        funnelVersionId: 'f1',
        name: 'Stage 1',
        order: 1,
        resolutionCriteria: { type: 'fragment_selected', fragment_id: 'frag1' },
        fragments: [
          {
            id: 'frag1',
            funnelVersionId: 'f1',
            stageId: 's1',
            type: 'normal',
            content: 'Hello {{name}}',
            deliveryMode: 'template',
            scoreWeight: 1,
            triggers: {}
          },
          {
            id: 'frag2',
            funnelVersionId: 'f1',
            stageId: 's1',
            type: 'normal',
            content: 'Price is {{price}}',
            deliveryMode: 'verbatim',
            scoreWeight: 1,
            triggers: {}
          },
          {
            id: 'frag3',
            funnelVersionId: 'f1',
            stageId: 's1',
            type: 'normal',
            content: 'Instruction for LLM',
            deliveryMode: 'llm',
            scoreWeight: 1,
            triggers: {}
          }
        ] as any[]
      }
    ],
    slots: []
  } as any;

  const mockState = {
    conversationId: 'conv1',
    funnelVersionId: 'f1',
    currentStageId: 's1',
    consecutiveStuckCount: 0,
    capturedSlots: {
      name: { value: 'Alice', verified: true }
    },
    version: 0,
    returnStack: []
  } as any;

  beforeEach(() => {
    repository = {
      getConversationState: vi.fn().mockResolvedValue(mockState),
      getFullVersion: vi.fn().mockResolvedValue(mockFunnel),
      getActiveVersion: vi.fn().mockResolvedValue(mockFunnel),
      updateConversationState: vi.fn().mockResolvedValue(undefined),
    };

    scorer = {
      score: vi.fn().mockImplementation((msg, fragments) => 
        fragments.map((f: any) => ({ fragment: f, score: 1.0, signals: {} }))
      )
    };

    scorerFactory = vi.fn().mockReturnValue(scorer);
    redis = {
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };

    runtime = new FunnelRuntime(repository, scorerFactory, redis as unknown as Redis);
  });

  it('Template mode should substitute variables', async () => {
    // Only return frag1
    scorer.score.mockReturnValue([{ fragment: mockFunnel.stages[0].fragments[0], score: 1.0, signals: {} }]);

    const result = await runtime.processMessage('t1', 'p1', 'conv1', 'hi');

    expect(result.scriptedReply).toBe('Hello Alice');
    expect(result.metadata.funnel?.delivery_mode).toBe('template');
  });

  it('Verbatim mode should return literal content even with braces', async () => {
    // Only return frag2
    scorer.score.mockReturnValue([{ fragment: mockFunnel.stages[0].fragments[1], score: 1.0, signals: {} }]);

    const result = await runtime.processMessage('t1', 'p1', 'conv1', 'price?');

    expect(result.scriptedReply).toBe('Price is {{price}}');
    expect(result.metadata.funnel?.delivery_mode).toBe('verbatim');
  });

  it('LLM mode should return raw instruction', async () => {
    // Only return frag3
    scorer.score.mockReturnValue([{ fragment: mockFunnel.stages[0].fragments[2], score: 1.0, signals: {} }]);

    const result = await runtime.processMessage('t1', 'p1', 'conv1', 'gen');

    expect(result.scriptedReply).toBe('Instruction for LLM');
    expect(result.metadata.funnel?.delivery_mode).toBe('llm');
  });

  it('Unresolved variables should be replaced with [уточнить]', async () => {
    // frag1 needs {{name}}, but let's clear slots
    const stateNoSlots = { ...mockState, capturedSlots: {} };
    repository.getConversationState.mockResolvedValue(stateNoSlots);
    scorer.score.mockReturnValue([{ fragment: mockFunnel.stages[0].fragments[0], score: 1.0, signals: {} }]);

    const result = await runtime.processMessage('t1', 'p1', 'conv1', 'hi');

    expect(result.scriptedReply).toBe('Hello [уточнить]');
  });

  it('Should filter fragments by delivery condition', async () => {
    // Add condition to frag1: only if tier=gold
    const fragWithCond = {
      ...mockFunnel.stages[0].fragments[0],
      deliveryCondition: { tier: 'gold' }
    };
    mockFunnel.stages[0].fragments[0] = fragWithCond;

    // Call with no tier slot
    await runtime.processMessage('t1', 'p1', 'conv1', 'hi');

    // Scorer should have been called WITHOUT frag1
    const fragmentsPassedToScorer = scorer.score.mock.calls[0][1];
    expect(fragmentsPassedToScorer.find((f: any) => f.id === 'frag1')).toBeUndefined();

    // Now add tier=gold to slots
    const stateGold = { 
      ...mockState, 
      capturedSlots: { 
        ...mockState.capturedSlots,
        tier: { value: 'gold', verified: true } 
      } 
    };
    repository.getConversationState.mockResolvedValue(stateGold);

    await runtime.processMessage('t1', 'p1', 'conv1', 'hi');
    const fragmentsPassedToScorer2 = scorer.score.mock.calls[1][1];
    expect(fragmentsPassedToScorer2.find((f: any) => f.id === 'frag1')).toBeDefined();
  });

  it('Should default deliveryMode to llm (backward compat)', async () => {
    const fragNoMode = {
      id: 'frag_old',
      content: 'Old fragment',
      scoreWeight: 1,
      triggers: {}
    };
    scorer.score.mockReturnValue([{ fragment: fragNoMode, score: 1.0, signals: {} }]);

    const result = await runtime.processMessage('t1', 'p1', 'conv1', 'hi');

    expect(result.metadata.funnel?.delivery_mode).toBe('llm');
  });

  // ── T025: Confirmation Gate ──

  describe('ConfirmationGate (T025)', () => {
    const confirmStage: FunnelStage & { fragments: any[] } = {
      id: 's_confirm',
      funnelVersionId: 'f1',
      name: 'Order Confirmation',
      order: 2,
      resolutionCriteria: { type: 'all_slots_filled' },
      nextStageId: 's3',
      requiredSlots: [],
      requiresConfirmation: true,
      confirmationPrompt: 'Оформляем заказ за {{price}}₽?',
      isAnytime: false,
      fragments: [],
    };

    const stageWithOffer: FunnelStage & { fragments: any[] } = {
      id: 's1',
      funnelVersionId: 'f1',
      name: 'Stage 1',
      order: 1,
      resolutionCriteria: { type: 'fragment_selected', fragment_id: 'frag1' },
      nextStageId: 's_confirm',
      requiredSlots: [],
      requiresConfirmation: false,
      isAnytime: false,
      fragments: [
        {
          id: 'frag1',
          funnelVersionId: 'f1',
          stageId: 's1',
          type: 'normal',
          content: 'Go ahead',
          deliveryMode: 'llm',
          scoreWeight: 1,
          triggers: {},
        },
      ],
    };

    it('Should show confirmation prompt when advancing to requiresConfirmation stage', async () => {
      const funnelConfirm: FullFunnel = {
        ...mockFunnel,
        stages: [stageWithOffer, confirmStage],
      } as any;
      repository.getFullVersion.mockResolvedValue(funnelConfirm);
      repository.getActiveVersion.mockResolvedValue(funnelConfirm);

      // Score frag1 high enough to trigger advance
      scorer.score.mockImplementation((msg: string, fragments: any[]) =>
        fragments.map((f: any) => ({ fragment: f, score: f.id === 'frag1' ? 1.0 : 0, signals: {} }))
      );

      const result = await runtime.processMessage('t1', 'p1', 'conv1', 'go ahead');

      expect(result.scriptedReply).toBe('Оформляем заказ за [уточнить]₽?');
      expect(repository.updateConversationState).toHaveBeenCalledWith(
        'conv1',
        expect.objectContaining({ pendingConfirmation: 's_confirm' }),
        expect.any(Number)
      );
    });

    it('Should advance on affirmative confirmation response', async () => {
      const stateWithPending = {
        ...mockState,
        pendingConfirmation: 's_confirm',
      };
      repository.getConversationState.mockResolvedValue(stateWithPending);
      // Need funnel with s_confirm stage for confirmation gate to find it
      const funnelWithConfirm: FullFunnel = {
        ...mockFunnel,
        stages: [...mockFunnel.stages, confirmStage],
      } as any;
      repository.getFullVersion.mockResolvedValue(funnelWithConfirm);

      const result = await runtime.processMessage('t1', 'p1', 'conv1', 'Да');

      expect(repository.updateConversationState).toHaveBeenCalledWith(
        'conv1',
        expect.objectContaining({
          currentStageId: 's_confirm',
          pendingConfirmation: null,
        }),
        expect.any(Number)
      );
    });

    it('Should stay on current stage on negative confirmation response', async () => {
      const stateWithPending = {
        ...mockState,
        pendingConfirmation: 's_confirm',
      };
      repository.getConversationState.mockResolvedValue(stateWithPending);
      const funnelWithConfirm: FullFunnel = {
        ...mockFunnel,
        stages: [...mockFunnel.stages, confirmStage],
      } as any;
      repository.getFullVersion.mockResolvedValue(funnelWithConfirm);

      const result = await runtime.processMessage('t1', 'p1', 'conv1', 'Нет');

      expect(repository.updateConversationState).toHaveBeenCalledWith(
        'conv1',
        expect.objectContaining({ pendingConfirmation: null }),
        expect.any(Number)
      );
      // Stage should NOT change
      expect(result.metadata.funnel?.stage_transition?.to).not.toBe('s_confirm');
    });
  });

  // ── T026: Anytime Trigger + LIFO ──

  describe('AnytimeTrigger (T026)', () => {
    const anytimeStage: FunnelStage & { fragments: any[] } = {
      id: 's_anytime',
      funnelVersionId: 'f1',
      name: 'FAQ',
      order: 10,
      resolutionCriteria: { type: 'all_slots_filled' },
      requiredSlots: [],
      requiresConfirmation: false,
      isAnytime: true,
      anytimeTriggers: ['вопрос', 'faq'],
      fragments: [],
    };

    const normalStage: FunnelStage & { fragments: any[] } = {
      id: 's_normal',
      funnelVersionId: 'f1',
      name: 'Normal',
      order: 1,
      resolutionCriteria: { type: 'fragment_selected', fragment_id: 'frag_n' },
      requiredSlots: [],
      requiresConfirmation: false,
      isAnytime: false,
      fragments: [
        {
          id: 'frag_n',
          funnelVersionId: 'f1',
          stageId: 's_normal',
          type: 'normal',
          content: 'Normal reply',
          deliveryMode: 'llm',
          scoreWeight: 1,
          triggers: {},
        },
      ],
    };

    it('Should trigger anytime stage and push to returnStack', async () => {
      const stateOnNormal = {
        ...mockState,
        currentStageId: 's_normal',
        returnStack: [],
      };
      repository.getConversationState.mockResolvedValue(stateOnNormal);

      const funnelAnytime: FullFunnel = {
        ...mockFunnel,
        stages: [normalStage, anytimeStage],
      } as any;
      repository.getFullVersion.mockResolvedValue(funnelAnytime);

      const result = await runtime.processMessage('t1', 'p1', 'conv1', 'у меня вопрос');

      expect(repository.updateConversationState).toHaveBeenCalledWith(
        'conv1',
        expect.objectContaining({
          currentStageId: 's_anytime',
          returnStack: ['s_normal'],
        }),
        expect.any(Number)
      );
    });

    it('Self-trigger: current stage is anytime → no-op', async () => {
      const stateOnAnytime = {
        ...mockState,
        currentStageId: 's_anytime',
        returnStack: [],
      };
      repository.getConversationState.mockResolvedValue(stateOnAnytime);

      const funnelAnytime: FullFunnel = {
        ...mockFunnel,
        stages: [normalStage, anytimeStage],
      } as any;
      repository.getFullVersion.mockResolvedValue(funnelAnytime);

      await runtime.processMessage('t1', 'p1', 'conv1', 'у меня вопрос');

      // Should NOT have triggered — self-trigger is no-op
      const allUpdates = repository.updateConversationState.mock.calls.map((c: any[]) => c[1]);
      const hasAnytimeSwitch = allUpdates.some((u: any) => u.currentStageId === 's_anytime' && Array.isArray(u.returnStack));
      expect(hasAnytimeSwitch).toBe(false);
    });

    it('Duplicate prevention: same stage in returnStack → no-op', async () => {
      const stateWithDup = {
        ...mockState,
        currentStageId: 's_normal',
        returnStack: ['s_anytime'],
      };
      repository.getConversationState.mockResolvedValue(stateWithDup);

      const funnelAnytime: FullFunnel = {
        ...mockFunnel,
        stages: [normalStage, anytimeStage],
      } as any;
      repository.getFullVersion.mockResolvedValue(funnelAnytime);

      await runtime.processMessage('t1', 'p1', 'conv1', 'у меня вопрос');

      // Should NOT have pushed duplicate — check that no update included returnStack with s_anytime
      const allUpdates = repository.updateConversationState.mock.calls.map((c: any[]) => c[1]);
      const hasAnytimePush = allUpdates.some((u: any) => Array.isArray(u.returnStack) && u.returnStack.includes('s_anytime'));
      expect(hasAnytimePush).toBe(false);
    });

    it('Max depth (3): 4th push rejected', async () => {
      const stateAtMax = {
        ...mockState,
        currentStageId: 's_normal',
        returnStack: ['s_a', 's_b', 's_c'],
      };
      repository.getConversationState.mockResolvedValue(stateAtMax);

      const funnelAnytime: FullFunnel = {
        ...mockFunnel,
        stages: [normalStage, anytimeStage],
      } as any;
      repository.getFullVersion.mockResolvedValue(funnelAnytime);

      await runtime.processMessage('t1', 'p1', 'conv1', 'у меня вопрос');

      // Should NOT push — stack already at depth 3
      const lastCall = repository.updateConversationState.mock.calls;
      const updateCall = lastCall[lastCall.length - 1];
      expect(updateCall[1].returnStack).toBeUndefined();
    });

    it('Pop: anytime stage resolved → returns to previous stage', async () => {
      const stateOnAnytimeResolved = {
        ...mockState,
        currentStageId: 's_anytime',
        returnStack: ['s_normal'],
        capturedSlots: {
          q1: { value: 'yes', verified: true },
        },
      };
      repository.getConversationState.mockResolvedValue(stateOnAnytimeResolved);

      // Stage with all_slots_filled resolution
      const anytimeResolved: FunnelStage & { fragments: any[] } = {
        ...anytimeStage,
        resolutionCriteria: { type: 'all_slots_filled' },
        fragments: [],
      };
      const funnelPop: FullFunnel = {
        ...mockFunnel,
        stages: [normalStage, anytimeResolved],
        slots: [{ id: 'slot_q1', funnelVersionId: 'f1', stageId: 's_anytime', name: 'q1', locked: false }],
      } as any;
      repository.getFullVersion.mockResolvedValue(funnelPop);

      await runtime.processMessage('t1', 'p1', 'conv1', 'done');

      expect(repository.updateConversationState).toHaveBeenCalledWith(
        'conv1',
        expect.objectContaining({
          currentStageId: 's_normal',
          returnStack: [],
        }),
        expect.any(Number)
      );
    });
  });
});
