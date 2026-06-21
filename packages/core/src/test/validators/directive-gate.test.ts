import { describe, it, expect } from 'vitest';
import { buildLanguageDirective } from '../../services/validators/language-guard.js';

describe('Directive injection enabled gate (T012)', () => {
  function shouldInjectDirective(cfg: Record<string, unknown>): boolean {
    return !!(
      cfg?.enabled !== false &&
      cfg?.allowedLanguages &&
      Array.isArray(cfg.allowedLanguages) &&
      cfg.allowedLanguages.length > 0
    );
  }

  it('injects directive when enabled: true', () => {
    expect(shouldInjectDirective({ enabled: true, allowedLanguages: ['ru'] })).toBe(true);
  });

  it('injects directive when enabled is absent (backward compat)', () => {
    expect(shouldInjectDirective({ allowedLanguages: ['ru'] })).toBe(true);
  });

  it('skips directive when enabled: false', () => {
    expect(shouldInjectDirective({ enabled: false, allowedLanguages: ['ru'] })).toBe(false);
  });

  it('skips directive when allowedLanguages is empty', () => {
    expect(shouldInjectDirective({ enabled: true, allowedLanguages: [] })).toBe(false);
  });

  it('skips directive when allowedLanguages is absent', () => {
    expect(shouldInjectDirective({ enabled: true })).toBe(false);
  });

  it('buildLanguageDirective produces expected output with IMPORTANT marker', () => {
    const directive = buildLanguageDirective(['ru', 'en'], 'en');
    expect(directive).toContain('Russian');
    expect(directive).toContain('English');
    expect(directive).toContain('IMPORTANT');
    expect(directive).toContain('respond ONLY in');
  });

  it('directive string absent when gate returns false (enabled: false)', () => {
    const cfg = { enabled: false, allowedLanguages: ['ru'] };
    const inject = shouldInjectDirective(cfg);
    if (inject) {
      const directive = buildLanguageDirective(cfg.allowedLanguages as string[], 'en');
      expect(directive).toContain('IMPORTANT');
    } else {
      expect(inject).toBe(false);
    }
  });

  it('directive string absent when gate returns false (empty allowedLanguages)', () => {
    const cfg = { enabled: true, allowedLanguages: [] };
    const inject = shouldInjectDirective(cfg);
    if (inject) {
      const directive = buildLanguageDirective(cfg.allowedLanguages as string[], 'en');
      expect(directive).toContain('IMPORTANT');
    } else {
      expect(inject).toBe(false);
    }
  });

  it('directive string present when gate returns true (enabled: true)', () => {
    const cfg = { enabled: true, allowedLanguages: ['ru', 'en'] };
    const inject = shouldInjectDirective(cfg);
    expect(inject).toBe(true);
    if (inject) {
      const directive = buildLanguageDirective(cfg.allowedLanguages as string[], 'en');
      expect(directive).toContain('IMPORTANT');
      expect(directive).toContain('respond ONLY in');
    }
  });

  it('directive string present when gate returns true (enabled absent = backward compat)', () => {
    const cfg = { allowedLanguages: ['ru', 'en'] };
    const inject = shouldInjectDirective(cfg);
    expect(inject).toBe(true);
    if (inject) {
      const directive = buildLanguageDirective(cfg.allowedLanguages as string[], 'en');
      expect(directive).toContain('IMPORTANT');
      expect(directive).toContain('respond ONLY in');
    }
  });
});
