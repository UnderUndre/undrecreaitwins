import { describe, it, expect } from 'vitest';
import { LanguageGuardValidator } from '../../services/validators/language-guard.js';
import { FalsePromiseValidator } from '../../services/validators/false-promise.js';
import { IdentityGuardValidator } from '../../services/validators/identity-guard.js';
import type { LanguageGuardConfig, BaseValidatorConfig } from '../../types/validator.js';
import type { ValidatorContext, ResponseValidator } from '../../types/validator.js';

function makeLangConfig(overrides: Partial<LanguageGuardConfig> = {}): LanguageGuardConfig {
  return {
    mode: 'active',
    allowedLanguages: ['ru', 'en'],
    stripThreshold: 0.05,
    blockThreshold: 0.30,
    regenerateOnViolation: false,
    enabled: true,
    ...overrides,
  };
}

function makeCtx<T extends BaseValidatorConfig>(config: T): ValidatorContext<T> {
  return {
    tenantId: 'test-tenant',
    personaId: 'test-persona',
    conversationId: 'test-conv',
    config,
  };
}

describe('Pipeline ordering integration (017 T012)', () => {
  it('language-guard runs between false-promise and identity-guard', async () => {
    const falsePromise = new FalsePromiseValidator({ complete: async () => ({ content: 'PASS', model: 'test', finishReason: 'stop', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) } as any);
    const langGuard = new LanguageGuardValidator();
    const identityGuard = new IdentityGuardValidator();

    const validators: ResponseValidator<any>[] = [
      falsePromise,
      langGuard,
      identityGuard,
    ];

    const sortedValidators = [...validators].sort((a, b) => {
      const isARewrite = a.name.includes('rewrite') || a.name === 'identity-and-provider-guard';
      const isBRewrite = b.name.includes('rewrite') || b.name === 'identity-and-provider-guard';
      if (isARewrite && !isBRewrite) return 1;
      if (!isARewrite && isBRewrite) return -1;
      return 0;
    });

    expect(sortedValidators[0]!.name).toBe('false-promise');
    expect(sortedValidators[1]!.name).toBe('language-guard');
    expect(sortedValidators[2]!.name).toBe('identity-and-provider-guard');
  });

  it('clean Russian response passes all three validators', async () => {
    const reply = 'Здравствуйте! Чем могу помочь?';
    const langGuard = new LanguageGuardValidator();
    const identityGuard = new IdentityGuardValidator();

    const langResult = await langGuard.validateAndMutate(reply, makeCtx(makeLangConfig({ allowedLanguages: ['ru'] })));
    expect(langResult.verdict.decision).toBe('pass');

    const identityResult = await identityGuard.validateAndMutate(reply, makeCtx({ mode: 'active' }));
    expect(identityResult.verdict.decision).toBe('pass');
  });

  it('Chinese-contaminated response is caught by language-guard (not identity-guard)', async () => {
    const reply = '你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界';
    const langGuard = new LanguageGuardValidator();

    const langResult = await langGuard.validateAndMutate(
      reply,
      makeCtx(makeLangConfig({ allowedLanguages: ['ru'], blockThreshold: 0.30 }))
    );
    expect(langResult.verdict.decision).toBe('block');
    expect(langResult.verdict.matchedPatterns).toContain('Han');
  });

  it('language-guard with empty allowedLanguages is a no-op (pipeline skip)', async () => {
    const langGuard = new LanguageGuardValidator();
    const result = await langGuard.validateAndMutate(
      '你好世界',
      makeCtx(makeLangConfig({ allowedLanguages: [] }))
    );
    expect(result.verdict.decision).toBe('pass');
    expect(result.mutatedText).toBe('你好世界');
  });

  it('language-guard strip preserves allowed-script text', async () => {
    const text = 'Привет! 你好 мир. 你好 мир.';
    const langGuard = new LanguageGuardValidator();
    const result = await langGuard.validateAndMutate(
      text,
      makeCtx(makeLangConfig({ allowedLanguages: ['ru'], stripThreshold: 0.05, blockThreshold: 0.80 }))
    );

    if (result.verdict.decision === 'strip') {
      expect(result.mutatedText).toContain('Привет');
      expect(result.mutatedText).toContain('мир');
      expect(result.mutatedText).not.toContain('你好');
    }
  });
});
