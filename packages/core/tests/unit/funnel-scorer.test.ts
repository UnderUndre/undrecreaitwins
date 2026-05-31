import { describe, it, expect, beforeAll } from 'vitest';
import { FragmentScorer } from '../../src/services/funnel/scorer.js';
import type { FunnelConfig, FunnelFragment } from '@undrecreaitwins/shared';

describe('FragmentScorer (Russian Stemming)', () => {
  const config: FunnelConfig = {
    relevance_threshold: 7,
    off_script_behavior: 'steer',
    stuck_threshold: 3,
    stuck_action: 'yield_generation',
    scoring_weights: {
      exact_match: 10,
      stemmed_match: 7,
      synonym_match: 5,
      stage_boost: 3,
      next_stage_bonus: 1.5,
      objection_boost: 2,
    }
  };

  const scorer = new FragmentScorer(config);

  const fragments: FunnelFragment[] = [
    {
      id: 'f1',
      funnelVersionId: 'v1',
      stageId: 's1',
      type: 'normal',
      content: 'Hello!',
      triggers: {
        phrases: ['Привет', 'Здравствуйте'],
        synonyms: { 'привет': ['хай', 'ку'] }
      },
      scoreWeight: 1.0
    },
    {
        id: 'f2',
        funnelVersionId: 'v1',
        stageId: 's1',
        type: 'normal',
        content: 'I am a bot.',
        triggers: {
          phrases: ['Кто ты?', 'Что ты умеешь?']
        },
        scoreWeight: 1.0
    }
  ];

  it('matches exact phrase', () => {
    const results = scorer.score('Привет', fragments, {});
    expect(results.find(r => r.fragment.id === 'f1')?.score).toBe(10);
  });

  it('matches stemmed word', () => {
    const results = scorer.score('Здравствуй', fragments, {});
    // 'здравствуй' stems to 'здравств' (same as 'здравствуйте')
    expect(results.find(r => r.fragment.id === 'f1')?.score).toBe(7);
  });

  it('matches synonym', () => {
    const results = scorer.score('Хай', fragments, {});
    expect(results.find(r => r.fragment.id === 'f1')?.score).toBe(5);
  });

  it('applies stage boost', () => {
    const results = scorer.score('Привет', fragments, { currentStageId: 's1' });
    expect(results.find(r => r.fragment.id === 'f1')?.score).toBe(13); // 10 (exact) + 3 (boost)
  });
});
