/**
 * FR-022: Output guard — post-generation filter pipeline.
 * Scans reply for hard-banned patterns → retries with repair prompt → fallback handoff.
 * Soft warnings are collected but do not block.
 *
 * Caller owns the rerun budget (remainingReruns); guard decrements it.
 * Verbatim fragments must be excluded by the caller (banned words do NOT apply to verbatim).
 */

import { filterBannedWords, type BannedWordsConfig } from './banned-words.js';

export interface OutputGuardResult {
  /** Final reply text (may be original or re-generated) */
  reply: string;
  /** True if reply is still hard-blocked after exhausting reruns */
  blocked: boolean;
  /** Number of reruns consumed from the budget */
  rerunsUsed: number;
  /** Soft-warnings collected across all attempts */
  warnings: string[];
}

export async function runOutputGuard(params: {
  reply: string;
  config: BannedWordsConfig;
  remainingReruns: number;
  regenerateFn: (repairPrompt: string) => Promise<string>;
}): Promise<OutputGuardResult> {
  const { reply, config, remainingReruns, regenerateFn } = params;

  const initial = filterBannedWords(reply, config);
  const allWarnings: string[] = [...initial.warnings];

  if (!initial.blocked) {
    return { reply, blocked: false, rerunsUsed: 0, warnings: allWarnings };
  }

  let currentReply = reply;
  let rerunsUsed = 0;

  for (let i = 0; i < remainingReruns; i++) {
    const repairPrompt = `Избегай фраз: ${initial.matches.join(', ')}. Переформулируй.`;
    currentReply = await regenerateFn(repairPrompt);
    rerunsUsed++;

    const result = filterBannedWords(currentReply, config);
    allWarnings.push(...result.warnings);

    if (!result.blocked) {
      return { reply: currentReply, blocked: false, rerunsUsed, warnings: allWarnings };
    }
  }

  return { reply: currentReply, blocked: true, rerunsUsed, warnings: allWarnings };
}
