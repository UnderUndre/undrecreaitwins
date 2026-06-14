import type { LLMClient } from '../llm-client.js';
import { FalsePromiseValidator } from '../validators/false-promise.js';
import { IdentityGuardValidator } from '../validators/identity-guard.js';
import { LanguageGuardValidator } from '../validators/language-guard.js';
import type { BaseValidatorConfig, ValidatorContext } from '../../types/validator.js';

export interface ReValidationResult {
  passed: boolean;
  reason?: string;
}

const PROMISE_LIKE_RE = /\b(?:гарантир|обеща|доставим\s+бесплатн|скидк[аи]\s+\d+|цена\s+\d+|price\s+\d+|%\s*off|free\s+delivery)\b/gi;

function hasNewPromiseTokens(original: string, rewritten: string): boolean {
  const origMatches = original.match(PROMISE_LIKE_RE) || [];
  const newMatches = rewritten.match(PROMISE_LIKE_RE) || [];
  return newMatches.length > origMatches.length;
}

export async function reValidate(
  llm: LLMClient,
  originalText: string,
  rewrittenText: string,
  context: { tenantId: string; personaId: string; conversationId: string; rawUserMessage?: string },
): Promise<ReValidationResult> {
  const validatorContext: ValidatorContext<BaseValidatorConfig> = {
    tenantId: context.tenantId,
    personaId: context.personaId,
    conversationId: context.conversationId,
    rawUserMessage: context.rawUserMessage,
    config: { mode: 'active' },
  };

  const identityGuard = new IdentityGuardValidator();
  const identityResult = await identityGuard.validateAndMutate(rewrittenText, validatorContext as any);
  if (identityResult.verdict.decision !== 'pass') {
    return { passed: false, reason: `identity-guard: ${identityResult.verdict.reason || 'violation'}` };
  }

  const langGuard = new LanguageGuardValidator();
  const langResult = await langGuard.validateAndMutate(rewrittenText, validatorContext as any);
  if (langResult.verdict.decision !== 'pass' && langResult.verdict.decision !== 'no_op') {
    return { passed: false, reason: `language-guard: ${langResult.verdict.reason || 'off-script'}` };
  }

  if (hasNewPromiseTokens(originalText, rewrittenText)) {
    const falsePromise = new FalsePromiseValidator(llm);
    const fpResult = await falsePromise.validateAndMutate(rewrittenText, validatorContext as any);
    if (fpResult.verdict.decision !== 'pass') {
      return { passed: false, reason: `false-promise: ${fpResult.verdict.reason || 'violation'}` };
    }
  }

  return { passed: true };
}
