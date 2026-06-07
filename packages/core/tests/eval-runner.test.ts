import { describe, expect, it, vi } from 'vitest';
import { EvalRunner } from '../src/services/eval-runner.js';
import type { ChatResponse } from '../src/services/chat-service.js';
import type { CreateEvalResultInput, EvalResultRow, EvalRunRow } from '../src/services/eval-repository.js';
import type { EvalCase } from '../src/services/eval-types.js';

const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeRun(overrides: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId,
    startedAt: new Date('2026-06-04T10:00:00.000Z'),
    finishedAt: null,
    totalCases: 1,
    passedCases: 0,
    ...overrides,
  };
}

function makeResult(input: CreateEvalResultInput): EvalResultRow {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    tenantId,
    runId: '11111111-1111-1111-1111-111111111111',
    caseName: input.caseName,
    passed: input.passed,
    response: input.response,
    assertionResults: input.assertionResults,
    createdAt: new Date('2026-06-04T10:01:00.000Z'),
  };
}

function makeChatResponse(content: string): ChatResponse {
  return {
    id: 'chatcmpl-eval-test',
    object: 'chat.completion',
    created: 1_780_000_000,
    model: 'test-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 10,
      total_tokens: 20,
    },
  };
}

describe('EvalRunner', () => {
  it('executes cases through ChatService and stores assertion results', async () => {
    const evalCase: EvalCase = {
      name: 'helpful-greeting',
      personaSlug: 'test-persona',
      messages: [{ role: 'user', content: 'Hello' }],
      assertions: [
        { type: 'contains', value: 'help' },
        { type: 'not_contains', value: 'forbidden' },
        { type: 'similarity', expected: 'Hello, I can help with questions and tasks.', threshold: 0.4 },
      ],
    };
    const complete = vi.fn().mockResolvedValue(makeChatResponse('Hello, I can help with questions and tasks.'));
    const inserted: CreateEvalResultInput[] = [];
    const repository = {
      createRun: vi.fn().mockResolvedValue(makeRun()),
      insertResults: vi.fn(async (_tenantId: string, _runId: string, results: CreateEvalResultInput[]) => {
        inserted.push(...results);
        return results.map((result) => makeResult(result));
      }),
      finishRun: vi.fn().mockResolvedValue(makeRun({
        finishedAt: new Date('2026-06-04T10:02:00.000Z'),
        passedCases: 1,
      })),
    };
    const runner = new EvalRunner({
      chatService: { complete },
      repository,
      caseLoader: { loadCases: vi.fn().mockResolvedValue([evalCase]) },
    });

    const output = await runner.run(tenantId);

    expect(complete).toHaveBeenCalledWith({
      tenantId,
      personaSlug: 'test-persona',
      messages: evalCase.messages,
      isTestThread: true,
      source: 'eval-harness',
    });
    expect(output.run.passedCases).toBe(1);
    expect(output.results[0]?.passed).toBe(true);
    expect(inserted[0]?.assertionResults.every((result) => result.passed)).toBe(true);
  });

  it('persists a failed result when chat execution fails', async () => {
    const evalCase: EvalCase = {
      name: 'missing-persona',
      personaSlug: 'missing',
      messages: [{ role: 'user', content: 'Hello' }],
      assertions: [{ type: 'min_length', value: 1 }],
    };
    const repository = {
      createRun: vi.fn().mockResolvedValue(makeRun()),
      insertResults: vi.fn(async (_tenantId: string, _runId: string, results: CreateEvalResultInput[]) => (
        results.map((result) => makeResult(result))
      )),
      finishRun: vi.fn().mockResolvedValue(makeRun({
        finishedAt: new Date('2026-06-04T10:02:00.000Z'),
        passedCases: 0,
      })),
    };
    const runner = new EvalRunner({
      chatService: { complete: vi.fn().mockRejectedValue(new Error('Persona missing')) },
      repository,
      caseLoader: { loadCases: vi.fn().mockResolvedValue([evalCase]) },
    });

    const output = await runner.run(tenantId);

    expect(output.run.passedCases).toBe(0);
    expect(output.results[0]?.passed).toBe(false);
    expect(output.results[0]?.assertionResults[0]?.type).toBe('execution');
  });
});
