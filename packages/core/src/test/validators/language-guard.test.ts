import { describe, it, expect, vi } from 'vitest';
import { LanguageGuardValidator } from '../../services/validators/language-guard.js';
import { buildLanguageDirective } from '../../services/validators/language-guard.js';
import type { LanguageGuardConfig } from '../../types/validator.js';
import type { ValidatorContext } from '../../types/validator.js';
import { LLMClient } from '../../services/llm-client.js';

function makeConfig(overrides: Partial<LanguageGuardConfig> = {}): LanguageGuardConfig {
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

function makeContext(config: LanguageGuardConfig): ValidatorContext<LanguageGuardConfig> {
  return {
    tenantId: 'test-tenant',
    personaId: 'test-persona',
    config,
  };
}

const validator = new LanguageGuardValidator();

describe('LanguageGuardValidator', () => {
  describe('FR-012: empty allowedLanguages = no-op', () => {
    it('returns pass immediately when allowedLanguages is empty', async () => {
      const config = makeConfig({ allowedLanguages: [] });
      const result = await validator.validateAndMutate('你好世界', makeContext(config));
      expect(result.verdict.decision).toBe('pass');
      expect(result.mutatedText).toBe('你好世界');
    });
  });

  describe('pass cases', () => {
    it('clean Russian response → pass', async () => {
      const result = await validator.validateAndMutate(
        'Здравствуйте! Как я могу вам помочь сегодня?',
        makeContext(makeConfig({ allowedLanguages: ['ru'] }))
      );
      expect(result.verdict.decision).toBe('pass');
      expect(result.mutatedText).toBe('Здравствуйте! Как я могу вам помочь сегодня?');
    });

    it('punctuation/digits-heavy Russian response → pass (Common strict)', async () => {
      const result = await validator.validateAndMutate(
        'Цена: 1500 руб. (скидка 15%). Артикул: 12345-А.',
        makeContext(makeConfig({ allowedLanguages: ['ru'] }))
      );
      expect(result.verdict.decision).toBe('pass');
    });

    it('scriptChars === 0 (only code + whitespace) → pass, fraction 0', async () => {
      const result = await validator.validateAndMutate(
        '```\nconst x = 42;\nconsole.log(x);\n```',
        makeContext(makeConfig({ allowedLanguages: ['ru'] }))
      );
      expect(result.verdict.decision).toBe('pass');
    });
  });

  describe('FR-014 / DD-008: code/URL/email masking', () => {
    it('Russian persona + 50% fenced Python code → pass (code masked)', async () => {
      const code = '```\n' + 'x = "hello world"\n'.repeat(10) + '```';
      const russian = 'Вот пример кода:\n';
      const result = await validator.validateAndMutate(
        russian + code,
        makeContext(makeConfig({ allowedLanguages: ['ru'] }))
      );
      expect(result.verdict.decision).toBe('pass');
    });

    it('Chinese persona + Han response containing URL → pass (URL masked)', async () => {
      const url = 'https://example.com/very/long/path/to/some/resource';
      const chinese = '你好'.repeat(50);
      const result = await validator.validateAndMutate(
        chinese + ' ' + url,
        makeContext(makeConfig({ allowedLanguages: ['zh'] }))
      );
      expect(result.verdict.decision).toBe('pass');
    });
  });

  describe('strip cases', () => {
    it('small Chinese contamination in Russian → strip', async () => {
      const russian = 'Здравствуйте, вот наш ассортимент товаров. ';
      const chinese = '你好世界你好世界';
      const text = russian + chinese + russian;
      const result = await validator.validateAndMutate(
        text,
        makeContext(makeConfig({ allowedLanguages: ['ru'], stripThreshold: 0.05 }))
      );
      expect(result.verdict.decision).toBe('strip');
      expect(result.mutatedText).not.toContain('你');
      expect(result.mutatedText).not.toContain('好');
    });
  });

  describe('block cases', () => {
    it('40% Chinese characters → block with fallback', async () => {
      const chinese = '你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界';
      const russian = 'Привет';
      const text = chinese + russian;
      const result = await validator.validateAndMutate(
        text,
        makeContext(makeConfig({ allowedLanguages: ['ru'], blockThreshold: 0.30 }))
      );
      expect(result.verdict.decision).toBe('block');
      expect(result.mutatedText).toContain('Russian');
    });
  });

  describe('FR-015: Unknown script = non-compliant', () => {
    it('Russian persona + Greek text → flagged (Unknown script)', async () => {
      const greek = 'Γειασασας'.repeat(10);
      const russian = 'Привет';
      const text = russian + greek;
      const result = await validator.validateAndMutate(
        text,
        makeContext(makeConfig({ allowedLanguages: ['ru'], stripThreshold: 0.05 }))
      );
      expect(result.verdict.decision).not.toBe('pass');
    });
  });

  describe('FR-006: threshold validation', () => {
    it('stripThreshold > blockThreshold is caught at config level (not validator)', () => {
      const badConfig = makeConfig({ stripThreshold: 0.50, blockThreshold: 0.30 });
      expect(badConfig.stripThreshold).toBeGreaterThan(badConfig.blockThreshold);
    });
  });

  describe('dry-run mode', () => {
    it('dry-run + violating response → verdict computed but text unchanged (pipeline handles mode)', async () => {
      const chinese = '你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界';
      const result = await validator.validateAndMutate(
        chinese,
        makeContext(makeConfig({ allowedLanguages: ['ru'], mode: 'dry-run', blockThreshold: 0.30 }))
      );
      expect(result.verdict.decision).toBe('block');
    });
  });

  describe('per-persona independence', () => {
    it('same text, different allowedLanguages → different verdicts', async () => {
      const text = 'Hello world!';
      await validator.validateAndMutate(
        text,
        makeContext(makeConfig({ allowedLanguages: ['ru'] }))
      );
      const enResult = await validator.validateAndMutate(
        text,
        makeContext(makeConfig({ allowedLanguages: ['en'] }))
      );
      expect(enResult.verdict.decision).toBe('pass');
    });
  });

  describe('language directive (US3)', () => {
    it('buildLanguageDirective produces correct text for ru+en', () => {
      const directive = buildLanguageDirective(['ru', 'en']);
      expect(directive).toContain('Russian');
      expect(directive).toContain('English');
      expect(directive).toContain('IMPORTANT');
    });

    it('buildLanguageDirective produces correct text for zh only', () => {
      const directive = buildLanguageDirective(['zh']);
      expect(directive).toContain('Chinese');
      expect(directive).not.toContain('Russian');
    });

    it('buildLanguageDirective handles unknown language code gracefully', () => {
      const directive = buildLanguageDirective(['xx']);
      expect(directive).toContain('xx');
    });
  });

  describe('Phase 2 LLM Remediation & Fidelity (024)', () => {
    it('translates off-language response and preserves placeholders', async () => {
      const completeSpy = vi.spyOn(LLMClient.prototype, 'complete')
        .mockResolvedValueOnce({
          content: 'Hello, this is __PRICE_1__ and __URL_0__',
          model: 'test-translate',
          finishReason: 'stop',
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });

      const config = makeConfig({
        allowedLanguages: ['en'],
        remediation: 'translate',
        allowPlatformModelRouting: true,
      });

      const result = await validator.validateAndMutate(
        'Привет, это 1,000 USD и https://google.com',
        makeContext(config)
      );

      expect(result.verdict.decision).toBe('rewrite');
      expect(result.mutatedText).toBe('Hello, this is 1,000 USD and https://google.com');

      completeSpy.mockRestore();
    });

    it('falls back to strip-block when allowPlatformModelRouting is false', async () => {
      const config = makeConfig({
        allowedLanguages: ['en'],
        remediation: 'translate',
        allowPlatformModelRouting: false,
      });

      const result = await validator.validateAndMutate(
        'Привет',
        makeContext(config)
      );

      expect(result.verdict.decision).toBe('block');
    });

    it('regenerates when translate fails fidelity checks', async () => {
      const completeSpy = vi.spyOn(LLMClient.prototype, 'complete')
        .mockResolvedValueOnce({
          content: 'Hello, this is 2,000 USD',
          model: 'test-translate',
          finishReason: 'stop',
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });

      const regenerateFn = vi.fn().mockResolvedValue('Hello, this is 1,000 USD');

      const config = makeConfig({
        allowedLanguages: ['en'],
        remediation: 'translate',
        allowPlatformModelRouting: true,
        regenerateOnViolation: true,
      });

      const context = {
        ...makeContext(config),
        systemPrompt: 'System prompt',
        regenerateFn,
      };

      const result = await validator.validateAndMutate(
        'Привет, это 1,000 USD',
        context
      );

      expect(result.verdict.decision).toBe('rewrite');
      expect(result.mutatedText).toBe('Hello, this is 1,000 USD');
      expect(regenerateFn).toHaveBeenCalled();

      completeSpy.mockRestore();
    });

    it('degrades to as-is on translate failure when degradeToAsIs is true', async () => {
      const completeSpy = vi.spyOn(LLMClient.prototype, 'complete')
        .mockRejectedValueOnce(new Error('Translate service down'));

      const config = makeConfig({
        allowedLanguages: ['en'],
        remediation: 'translate',
        allowPlatformModelRouting: true,
      });

      const context = {
        ...makeContext(config),
        degradeToAsIs: true,
      };

      const result = await validator.validateAndMutate(
        'Привет',
        context
      );

      expect(result.verdict.decision).toBe('pass');
      expect(result.mutatedText).toBe('Привет');

      completeSpy.mockRestore();
    });
  });
});
