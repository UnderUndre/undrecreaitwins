import { describe, it, expect } from 'vitest';
import { compose } from '../../services/feedback/prompt-composer.js';
import type { FeedbackMemory } from '../../services/feedback/types.js';

function makeMemory(overrides: Partial<FeedbackMemory> = {}): FeedbackMemory {
  return {
    id: 'mem-1', tenantId: 't1', personaId: 'p1',
    contextEmbedding: [], lesson: 'Be more friendly',
    status: 'active', operatorRole: 'admin', weight: 1.0,
    sourceConversationId: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

describe('PromptComposer', () => {
  it('assembles persona + feedback within budget', () => {
    const result = compose({
      personaPrompt: 'You are a helpful assistant.',
      feedbackMemories: [makeMemory()],
      ragChunks: [],
      feedbackTokenBudget: 500,
    });
    expect(result.systemPrompt).toContain('helpful assistant');
    expect(result.systemPrompt).toContain('Be more friendly');
    expect(result.layers.feedback.itemsIncluded).toBe(1);
  });

  it('enforces persona hard floor (500 tokens)', () => {
    const longPrompt = 'x'.repeat(10000);
    const result = compose({
      personaPrompt: longPrompt,
      feedbackMemories: [],
      ragChunks: [],
      feedbackTokenBudget: 500,
      systemPromptBudget: 2000,
    });
    expect(result.layers.persona.tokens).toBeLessThan(estimateTokens(longPrompt));
    expect(result.layers.persona.truncated).toBe(true);
  });

  it('truncates feedback memories to budget', () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ id: `m${i}`, lesson: `Lesson ${i}: `.repeat(100) }),
    );
    const result = compose({
      personaPrompt: 'short',
      feedbackMemories: memories,
      ragChunks: [],
      feedbackTokenBudget: 350,
    });
    expect(result.layers.feedback.itemsIncluded).toBeLessThan(10);
  });

  it('skips RAG when budget < 200 tokens after persona+feedback', () => {
    const memories = Array.from({ length: 3 }, (_, i) =>
      makeMemory({ id: `m${i}`, lesson: 'y'.repeat(200 * 4) }),
    );
    const result = compose({
      personaPrompt: 'x'.repeat(3500 * 4),
      feedbackMemories: memories,
      ragChunks: [{ text: 'RAG content that should not fit', score: 0.9, metadata: { documentId: 'd1', chunkIndex: 0 } }],
      feedbackTokenBudget: 500,
      systemPromptBudget: 4000,
    });
    expect(result.layers.feedback.itemsIncluded).toBeGreaterThanOrEqual(2);
    expect(result.layers.rag.itemsIncluded).toBe(0);
  });

  it('includes conflict directive', () => {
    const result = compose({
      personaPrompt: 'test',
      feedbackMemories: [makeMemory()],
      ragChunks: [],
      feedbackTokenBudget: 500,
    });
    expect(result.systemPrompt).toContain('factual grounding from RAG is authoritative');
  });

  it('wraps feedback in operator_instructions delimiter (seam C)', () => {
    const result = compose({
      personaPrompt: 'test',
      feedbackMemories: [makeMemory({ lesson: 'test lesson' })],
      ragChunks: [],
      feedbackTokenBudget: 500,
    });
    expect(result.systemPrompt).toContain('<operator_instructions>');
    expect(result.systemPrompt).toContain('test lesson');
  });
});

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
