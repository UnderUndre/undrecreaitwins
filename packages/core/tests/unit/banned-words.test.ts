import { describe, it, expect, vi } from 'vitest';
import { filterBannedWords, type BannedWordsConfig } from '../../src/services/llm/guards/banned-words.js';
import { runOutputGuard, type OutputGuardResult } from '../../src/services/llm/guards/output-guard.js';

const defaultConfig: BannedWordsConfig = {
  hard: [/я языковая модель/gi, /как искусственный интеллект/gi],
  soft: ['в качестве', 'следует отметить', 'инновационный'],
};

describe('filterBannedWords', () => {
  it('hard blocks reply containing "я языковая модель"', () => {
    const result = filterBannedWords(
      'Я языковая модель и не могу выполнить этот запрос.',
      defaultConfig,
    );
    expect(result.blocked).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatch(/языковая модель/i);
    expect(result.warnings).toHaveLength(0);
  });

  it('soft warns on "в качестве" without blocking', () => {
    const result = filterBannedWords(
      'Данный продукт используется в качестве примера.',
      defaultConfig,
    );
    expect(result.blocked).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(result.warnings).toContain('в качестве');
  });

  it('returns no blocks or warnings for clean reply', () => {
    const result = filterBannedWords(
      'Стоимость услуги составляет 5000 рублей.',
      defaultConfig,
    );
    expect(result.blocked).toBe(false);
    expect(result.matches).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('OutputGuard', () => {
  it('passes clean reply on first check without rerun', async () => {
    const result = await runOutputGuard({
      reply: 'Доставка бесплатная.',
      config: defaultConfig,
      remainingReruns: 2,
      regenerateFn: vi.fn(),
    });

    expect(result.blocked).toBe(false);
    expect(result.rerunsUsed).toBe(0);
    expect(result.reply).toBe('Доставка бесплатная.');
  });

  it('blocks on 1st gen, reruns, passes on 2nd gen clean reply', async () => {
    const regenerateFn = vi.fn()
      .mockResolvedValue('Данный товар используется в качестве подарка.');

    const result = await runOutputGuard({
      reply: 'Я языковая модель.',
      config: defaultConfig,
      remainingReruns: 2,
      regenerateFn,
    });

    expect(result.blocked).toBe(false);
    expect(result.rerunsUsed).toBe(1);
    expect(regenerateFn).toHaveBeenCalledTimes(1);
    expect(regenerateFn.mock.calls[0][0]).toContain('Избегай фраз');
    expect(result.warnings).toContain('в качестве');
  });

  it('blocks after 1st + 2nd gen both blocked (budget exhausted)', async () => {
    const regenerateFn = vi.fn()
      .mockResolvedValue('Как искусственный интеллект я не знаю.');

    const result = await runOutputGuard({
      reply: 'Я языковая модель.',
      config: defaultConfig,
      remainingReruns: 2,
      regenerateFn,
    });

    expect(result.blocked).toBe(true);
    expect(result.rerunsUsed).toBe(2);
    expect(regenerateFn).toHaveBeenCalledTimes(2);
    expect(result.reply).toContain('искусственный интеллект');
  });

  it('returns handoff immediately when remainingReruns=0', async () => {
    const regenerateFn = vi.fn();

    const result = await runOutputGuard({
      reply: 'Я языковая модель.',
      config: defaultConfig,
      remainingReruns: 0,
      regenerateFn,
    });

    expect(result.blocked).toBe(true);
    expect(result.rerunsUsed).toBe(0);
    expect(regenerateFn).not.toHaveBeenCalled();
  });

  it('verbatim fragment with banned word → caller must skip guard, not blocked', () => {
    const verbatimText = 'Я языковая модель и не могу помочь.';
    const isVerbatim = true;

    const result = isVerbatim ? null : filterBannedWords(verbatimText, defaultConfig);

    expect(result).toBeNull();
    expect(isVerbatim).toBe(true);
  });
});
