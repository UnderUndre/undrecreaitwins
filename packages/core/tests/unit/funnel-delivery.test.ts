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
});
