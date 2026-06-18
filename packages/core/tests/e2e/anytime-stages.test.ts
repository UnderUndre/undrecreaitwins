/**
 * T026 — FR-015 Anytime Stages E2E
 *
 * Tests the anytime trigger → LIFO return stack lifecycle:
 * 1. Happy path: trigger → resolve → pop back to original
 * 2. Nested anytime (depth 2): both resolve → back to original
 * 3. Max depth (3): 4th trigger rejected
 * 4. Self-trigger: current stage re-triggers → no-op
 * 5. Duplicate: stage already in stack → no-op
 * 6. Stale stage: popped ID deleted from funnel → skip + pop next
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FunnelRuntime } from '../../src/services/funnel/funnel-runtime.js';
import type { FullFunnel, FunnelStage, FunnelFragment, ConversationFunnelState } from '@undrecreaitwins/shared';

vi.mock('../../src/db.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
  },
}));

vi.mock('../../src/models/index.js', () => ({
  conversations: { slots: 'slots', id: 'id' },
}));

// ── Fixtures ──

function buildFunnel(stages: (FunnelStage & { fragments: FunnelFragment[] })[], slots: any[] = []): FullFunnel {
  return {
    id: 'ver_anytime',
    definitionId: 'def_anytime',
    versionNumber: 1,
    isActive: true,
    createdAt: new Date(),
    config: {
      relevance_threshold: 0.3,
      off_script_behavior: 'steer',
      stuck_threshold: 5,
      stuck_action: 'handoff',
      scoring_weights: {
        exact_match: 1, stemmed_match: 1, synonym_match: 1,
        stage_boost: 1, next_stage_bonus: 1, objection_boost: 1,
      },
      maxTurnReruns: 2,
      maxTurnLLMCalls: 6,
    },
    definition: {
      id: 'def_anytime', tenantId: 't1', personaId: 'p1',
      name: 'Anytime Test', createdAt: new Date(), deletedAt: null,
    },
    stages,
    slots,
  } as any;
}

function buildState(overrides: Partial<ConversationFunnelState> = {}): ConversationFunnelState {
  return {
    conversationId: 'conv_anytime',
    funnelVersionId: 'ver_anytime',
    currentStageId: 'stage_main',
    consecutiveStuckCount: 0,
    capturedSlots: {},
    returnStack: [],
    activeTopics: [],
    unresolvedObjections: [],
    messagesOnCurrentStage: 0,
    pendingStageOffer: null,
    pendingConfirmation: null,
    version: 0,
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMainStage(): FunnelStage & { fragments: FunnelFragment[] } {
  return {
    id: 'stage_main',
    funnelVersionId: 'ver_anytime',
    name: 'Main',
    order: 1,
    resolutionCriteria: { type: 'fragment_selected', fragment_id: 'frag_main' },
    requiredSlots: [],
    requiresConfirmation: false,
    isAnytime: false,
    fragments: [
      {
        id: 'frag_main', funnelVersionId: 'ver_anytime', stageId: 'stage_main',
        type: 'normal', content: 'Main reply', deliveryMode: 'llm', scoreWeight: 1, triggers: {},
      },
    ],
  };
}

function makeAnytimeStage(id: string, name: string, triggers: string[], order = 10): FunnelStage & { fragments: FunnelFragment[] } {
  return {
    id,
    funnelVersionId: 'ver_anytime',
    name,
    order,
    resolutionCriteria: { type: 'all_slots_filled' },
    requiredSlots: [],
    requiresConfirmation: false,
    isAnytime: true,
    anytimeTriggers: triggers,
    fragments: [],
  };
}

// ── Runtime factory ──

function createRuntime(repository: any, scorer?: any) {
  const defaultScorer = {
    score: vi.fn().mockImplementation((_msg: string, fragments: any[]) =>
      fragments.map((f: any) => ({ fragment: f, score: 0.9, signals: {} })),
    ),
  };
  const s = scorer ?? defaultScorer;
  return new FunnelRuntime(repository, () => s);
}

// ── Tests ──

describe('Anytime Stages E2E', () => {
  let repository: any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Case 1: Happy path ──

  it('trigger anytime → process → resolution met → pop back to original', async () => {
    const anytime = makeAnytimeStage('stage_faq', 'FAQ', ['вопрос']);
    const main = makeMainStage();
    main.nextStageId = undefined;

    const funnel = buildFunnel([main, anytime]);
    const state = buildState({ currentStageId: 'stage_main', returnStack: [] });

    repository = {
      getConversationState: vi.fn().mockResolvedValue(state),
      getActiveVersion: vi.fn().mockResolvedValue(funnel),
      getFullVersion: vi.fn().mockResolvedValue(funnel),
      updateConversationState: vi.fn().mockResolvedValue(undefined),
    };

    const runtime = createRuntime(repository);

    // Step 1: trigger anytime
    const r1 = await runtime.processMessage('t1', 'p1', 'conv_anytime', 'у меня вопрос');
    expect(repository.updateConversationState).toHaveBeenCalledWith(
      'conv_anytime',
      expect.objectContaining({
        currentStageId: 'stage_faq',
        returnStack: ['stage_main'],
      }),
      expect.any(Number),
    );

    // Step 2: simulate state after trigger — now on FAQ with returnStack
    const stateOnFaq = buildState({
      currentStageId: 'stage_faq',
      returnStack: ['stage_main'],
      capturedSlots: { q1: { value: 'yes', verified: true, captured_at: new Date().toISOString() } },
    });
    repository.getConversationState.mockResolvedValue(stateOnFaq);

    const r2 = await runtime.processMessage('t1', 'p1', 'conv_anytime', 'готово');

    // Should pop back to stage_main
    expect(repository.updateConversationState).toHaveBeenCalledWith(
      'conv_anytime',
      expect.objectContaining({
        currentStageId: 'stage_main',
        returnStack: [],
      }),
      expect.any(Number),
    );
  });

  // ── Case 2: Nested anytime (depth 2) ──

  it('nested anytime: depth 2 → both resolve → back to original', async () => {
    const anytimeInner = makeAnytimeStage('stage_faq_inner', 'FAQ Inner', ['цена']);
    const anytimeOuter = makeAnytimeStage('stage_faq_outer', 'FAQ Outer', ['вопрос'], 11);
    const main = makeMainStage();

    const funnel = buildFunnel([main, anytimeOuter, anytimeInner]);

    // Step 1: trigger outer anytime
    const state0 = buildState({ currentStageId: 'stage_main', returnStack: [] });
    repository = {
      getConversationState: vi.fn().mockResolvedValue(state0),
      getActiveVersion: vi.fn().mockResolvedValue(funnel),
      getFullVersion: vi.fn().mockResolvedValue(funnel),
      updateConversationState: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = createRuntime(repository);

    await runtime.processMessage('t1', 'p1', 'conv_anytime', 'у меня вопрос');
    expect(repository.updateConversationState).toHaveBeenCalledWith(
      'conv_anytime',
      expect.objectContaining({
        currentStageId: 'stage_faq_outer',
        returnStack: ['stage_main'],
      }),
      expect.any(Number),
    );

    // Step 2: on outer FAQ, trigger inner anytime
    const state1 = buildState({
      currentStageId: 'stage_faq_outer',
      returnStack: ['stage_main'],
    });
    repository.getConversationState.mockResolvedValue(state1);

    await runtime.processMessage('t1', 'p1', 'conv_anytime', 'а какая цена?');
    expect(repository.updateConversationState).toHaveBeenCalledWith(
      'conv_anytime',
      expect.objectContaining({
        currentStageId: 'stage_faq_inner',
        returnStack: ['stage_main', 'stage_faq_outer'],
      }),
      expect.any(Number),
    );

    // Step 3: resolve inner FAQ → pop to outer FAQ
    const state2 = buildState({
      currentStageId: 'stage_faq_inner',
      returnStack: ['stage_main', 'stage_faq_outer'],
      capturedSlots: { price_q: { value: '100', verified: true, captured_at: new Date().toISOString() } },
    });
    repository.getConversationState.mockResolvedValue(state2);

    await runtime.processMessage('t1', 'p1', 'conv_anytime', 'ясно');
    expect(repository.updateConversationState).toHaveBeenCalledWith(
      'conv_anytime',
      expect.objectContaining({
        currentStageId: 'stage_faq_outer',
        returnStack: ['stage_main'],
      }),
      expect.any(Number),
    );

    // Step 4: resolve outer FAQ → pop to main
    const state3 = buildState({
      currentStageId: 'stage_faq_outer',
      returnStack: ['stage_main'],
      capturedSlots: { q1: { value: 'ok', verified: true, captured_at: new Date().toISOString() } },
    });
    repository.getConversationState.mockResolvedValue(state3);

    await runtime.processMessage('t1', 'p1', 'conv_anytime', 'понял');
    expect(repository.updateConversationState).toHaveBeenCalledWith(
      'conv_anytime',
      expect.objectContaining({
        currentStageId: 'stage_main',
        returnStack: [],
      }),
      expect.any(Number),
    );
  });

  // ── Case 3: Max depth (3) ──

  it('max depth (3): 4th anytime trigger rejected → stays on current', async () => {
    const anytimeA = makeAnytimeStage('stage_a', 'A', ['а']);
    const anytimeB = makeAnytimeStage('stage_b', 'B', ['б'], 11);
    const anytimeC = makeAnytimeStage('stage_c', 'C', ['в'], 12);
    const anytimeD = makeAnytimeStage('stage_d', 'D', ['г'], 13);
    const main = makeMainStage();

    const funnel = buildFunnel([main, anytimeA, anytimeB, anytimeC, anytimeD]);

    // State: already at depth 3 (returnStack has 3 entries)
    const stateAtMax = buildState({
      currentStageId: 'stage_c',
      returnStack: ['stage_main', 'stage_a', 'stage_b'],
    });

    repository = {
      getConversationState: vi.fn().mockResolvedValue(stateAtMax),
      getActiveVersion: vi.fn().mockResolvedValue(funnel),
      getFullVersion: vi.fn().mockResolvedValue(funnel),
      updateConversationState: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = createRuntime(repository);

    // Trigger anytimeD — should be rejected (stack depth = 3, max = 3)
    await runtime.processMessage('t1', 'p1', 'conv_anytime', 'г');

    // No update should have currentStageId changed to stage_d
    const allUpdates = repository.updateConversationState.mock.calls.map((c: any[]) => c[1]);
    const switchedToD = allUpdates.some((u: any) => u.currentStageId === 'stage_d');
    expect(switchedToD).toBe(false);
  });

  // ── Case 4: Self-trigger ──

  it('self-trigger: current stage is the anytime stage → no-op', async () => {
    const anytime = makeAnytimeStage('stage_faq', 'FAQ', ['вопрос']);
    const main = makeMainStage();

    const funnel = buildFunnel([main, anytime]);
    const state = buildState({ currentStageId: 'stage_faq', returnStack: ['stage_main'] });

    repository = {
      getConversationState: vi.fn().mockResolvedValue(state),
      getActiveVersion: vi.fn().mockResolvedValue(funnel),
      getFullVersion: vi.fn().mockResolvedValue(funnel),
      updateConversationState: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = createRuntime(repository);

    // "у меня вопрос" matches FAQ trigger, but we're already on FAQ
    await runtime.processMessage('t1', 'p1', 'conv_anytime', 'у меня вопрос');

    // Should NOT push to returnStack again — self-trigger is no-op
    const allUpdates = repository.updateConversationState.mock.calls.map((c: any[]) => c[1]);
    const hasAnytimePush = allUpdates.some(
      (u: any) => u.currentStageId === 'stage_faq' && Array.isArray(u.returnStack),
    );
    expect(hasAnytimePush).toBe(false);
  });

  // ── Case 5: Duplicate ──

  it('duplicate: same stage already in returnStack → no-op', async () => {
    const anytime = makeAnytimeStage('stage_faq', 'FAQ', ['вопрос']);
    const main = makeMainStage();

    const funnel = buildFunnel([main, anytime]);
    const state = buildState({
      currentStageId: 'stage_main',
      returnStack: ['stage_faq'],
    });

    repository = {
      getConversationState: vi.fn().mockResolvedValue(state),
      getActiveVersion: vi.fn().mockResolvedValue(funnel),
      getFullVersion: vi.fn().mockResolvedValue(funnel),
      updateConversationState: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = createRuntime(repository);

    await runtime.processMessage('t1', 'p1', 'conv_anytime', 'у меня вопрос');

    // Should NOT push duplicate — returnStack already contains stage_faq
    const allUpdates = repository.updateConversationState.mock.calls.map((c: any[]) => c[1]);
    const hasDupPush = allUpdates.some(
      (u: any) => Array.isArray(u.returnStack) && u.returnStack.includes('stage_faq'),
    );
    expect(hasDupPush).toBe(false);
  });

  // ── Case 6: Stale stage ──

  it('stale stage: popped stageId deleted from funnel → skip + pop next', async () => {
    const anytime = makeAnytimeStage('stage_faq', 'FAQ', ['вопрос']);
    const main = makeMainStage();

    // "stage_deleted" does NOT exist in funnel.stages — simulates a deleted stage
    const funnel = buildFunnel([main, anytime]);

    // returnStack: ['stage_deleted', 'stage_main']
    // When FAQ resolves, it pops 'stage_deleted' first → stale → skip → pop 'stage_main'
    const stateOnFaq = buildState({
      currentStageId: 'stage_faq',
      returnStack: ['stage_deleted', 'stage_main'],
      capturedSlots: { q1: { value: 'ok', verified: true, captured_at: new Date().toISOString() } },
    });

    repository = {
      getConversationState: vi.fn().mockResolvedValue(stateOnFaq),
      getActiveVersion: vi.fn().mockResolvedValue(funnel),
      getFullVersion: vi.fn().mockResolvedValue(funnel),
      updateConversationState: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = createRuntime(repository);

    await runtime.processMessage('t1', 'p1', 'conv_anytime', 'готово');

    // Should skip stage_deleted and pop to stage_main
    expect(repository.updateConversationState).toHaveBeenCalledWith(
      'conv_anytime',
      expect.objectContaining({
        currentStageId: 'stage_main',
        returnStack: ['stage_deleted'],
      }),
      expect.any(Number),
    );
  });
});
