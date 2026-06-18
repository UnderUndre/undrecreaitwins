/**
 * FR-021: Banned words filter — two tiers:
 *   - Hard block (regex): reply is blocked, caller retries with repair prompt.
 *   - Soft warn (keyword): reply passes, warnings logged for analysis.
 *
 * Verbatim fragments are NOT filtered — caller is responsible for skipping.
 */

import { getPrompt } from '../../../prompts/index.js';
import type { Locale } from '../../../prompts/types.js';

export interface BannedWordsConfig {
  /** Regex patterns that hard-block the reply (e.g. /я языковая модель/i) */
  hard: RegExp[];
  /** Plain-text keywords that produce soft warnings (e.g. 'инновационный') */
  soft: string[];
}

export interface BannedWordsResult {
  blocked: boolean;
  matches: string[];
  warnings: string[];
}

export function getDefaultBannedWordsConfig(locale: Locale = 'ru'): BannedWordsConfig {
  const tpl = getPrompt('banned-words', locale) as unknown as { hard: string[]; soft: string[] };
  return {
    hard: tpl.hard.map(pattern => new RegExp(pattern, 'i')),
    soft: tpl.soft,
  };
}

export function filterBannedWords(
  reply: string,
  config: BannedWordsConfig,
): BannedWordsResult {
  const matches: string[] = [];
  const warnings: string[] = [];

  for (const re of config.hard) {
    const m = reply.match(re);
    if (m) {
      matches.push(m[0]);
    }
  }

  if (matches.length > 0) {
    return { blocked: true, matches, warnings: [] };
  }

  const lowerReply = reply.toLowerCase();
  for (const kw of config.soft) {
    if (lowerReply.includes(kw.toLowerCase())) {
      warnings.push(kw);
    }
  }

  return { blocked: false, matches: [], warnings };
}
