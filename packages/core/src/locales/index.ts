import { en } from './language-guard.en.js';
import { ru } from './language-guard.ru.js';

const locales = { en, ru };

export function getLanguageGuardPrompt(key: keyof typeof en, locale: 'en' | 'ru' = 'ru'): string {
  return locales[locale][key];
}
