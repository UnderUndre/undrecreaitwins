import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidatorPipeline } from '../../services/validators/pipeline.js';
import { LanguageGuardValidator } from '../../services/validators/language-guard.js';

let mockConfigRow: Record<string, unknown> | undefined;

vi.mock('../../db.js', () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        return Promise.resolve(mockConfigRow ? [mockConfigRow] : []);
      }),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
      then: undefined as unknown as ((resolve: (v: unknown) => void) => void) | undefined,
    };
    chain.then = (resolve: (v: unknown) => void) => resolve(mockConfigRow ? [mockConfigRow] : []);
    return fn(chain);
  }),
}));

const mockLLM = {
  complete: vi.fn().mockResolvedValue({
    content: 'test response',
    model: 'test',
    finishReason: 'stop',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }),
} as any;

describe('ValidatorPipeline enabled toggle (T012)', () => {
  let pipeline: ValidatorPipeline;
  let langGuardSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigRow = undefined;
    pipeline = new ValidatorPipeline(mockLLM);
    langGuardSpy = vi.spyOn(LanguageGuardValidator.prototype, 'validateAndMutate');
  });

  it('skips language-guard when enabled: false', async () => {
    mockConfigRow = {
      config: { enabled: false, allowedLanguages: ['ru'], stripThreshold: 0.05, blockThreshold: 0.30 },
      mode: 'active',
    };

    const result = await pipeline.validateResponse('Hello world', {
      tenantId: 't1',
      personaId: 'p1',
      conversationId: 'c1',
    });

    expect(langGuardSpy).not.toHaveBeenCalled();
    expect(result).toBe('Hello world');
  });

  it('runs language-guard when enabled: true', async () => {
    mockConfigRow = {
      config: { enabled: true, allowedLanguages: ['ru'], stripThreshold: 0.05, blockThreshold: 0.30 },
      mode: 'active',
    };

    await pipeline.validateResponse('Hello world', {
      tenantId: 't1',
      personaId: 'p1',
      conversationId: 'c1',
    });

    expect(langGuardSpy).toHaveBeenCalled();
  });

  it('runs language-guard when enabled is absent (backward compat = true)', async () => {
    mockConfigRow = {
      config: { allowedLanguages: ['ru'], stripThreshold: 0.05, blockThreshold: 0.30 },
      mode: 'active',
    };

    await pipeline.validateResponse('Hello world', {
      tenantId: 't1',
      personaId: 'p1',
      conversationId: 'c1',
    });

    expect(langGuardSpy).toHaveBeenCalled();
  });
});
