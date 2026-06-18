import type { Locale, PromptKey, PromptTemplate } from './types.js';
import ru from './ru/index.js';
import en from './en/index.js';

const byLocale: Record<Locale, Record<PromptKey, PromptTemplate>> = { ru, en };

const DEFAULT_LOCALE: Locale = 'ru';

export function getPrompt(key: PromptKey, locale: Locale = DEFAULT_LOCALE): PromptTemplate {
  return byLocale[locale][key];
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? '');
}

export type { Locale, PromptKey, PromptTemplate };
