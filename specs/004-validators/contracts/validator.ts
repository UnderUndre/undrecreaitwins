// specs/004-validators/contracts/validator.ts

export type ValidatorMode = 'active' | 'dry-run';

export type VerdictDecision =
  | 'pass'
  | 'append_disclaimer'
  | 'block'
  | 'strip'
  | 'no_op'
  | 'error'; // validator/orchestrator failure resolved via fail-policy (FR-016)

/**
 * Base config shared by every validator — `mode` is always present.
 * Per-validator specifics live in the typed members below. No `[key: string]: any`
 * index signature: unknown extra keys are rejected at the Zod boundary (FR-011),
 * so a typo like `minConfedence` fails validation instead of silently at runtime.
 */
export interface BaseValidatorConfig {
  mode: ValidatorMode;
}

/** Back-compat alias for the entity name used in spec.md / data-model.md. */
export type ValidatorConfig = BaseValidatorConfig;

export interface FalsePromiseConfig extends BaseValidatorConfig {
  minConfidence: number; // default 0.7 (FR-006)
  timeoutMs: number; // default 1500 (FR-006)
  remediation: 'append_disclaimer' | 'block';
  disclaimerText?: string; // FR-007 — appended on `append_disclaimer`; system default if omitted (language-neutral)
  blockFallbackMessage?: string; // FR-007 — substituted reply on `block`; system default if omitted (language-neutral)
  judgeModel?: string; // FR-004 — defaults to env VALIDATOR_JUDGE_MODEL (cheaper than generation model)
}

export interface FormatInjectionConfig extends BaseValidatorConfig {
  maxInputChars?: number; // FR-022 — length cap before regex evaluation (ReDoS bound)
}

export interface IdentityGuardConfig extends BaseValidatorConfig {
  fallbackMessage?: string; // FR-008 — persona-localized rewrite target. Absent ⇒ validator stays dry-run by default (FR-015)
  applyToTier1?: boolean; // FR-008 — also guard the greeting/intake (Tier-1) stage
  maxInputChars?: number; // FR-022 — ReDoS bound on the RU/EN identity regexes
}

export type AnyValidatorConfig =
  | FalsePromiseConfig
  | FormatInjectionConfig
  | IdentityGuardConfig;

export interface Verdict {
  decision: VerdictDecision;
  confidence?: number; // deterministic validators report 1.0 (see data-model + SC-002)
  reason?: string;
  matchedPatternClass?: string;
  matchedPatterns?: string[]; // FR-007 — populated when multiple matches collapse into one remediation
}

export interface ValidatorContext<T extends BaseValidatorConfig = BaseValidatorConfig> {
  tenantId: string;
  personaId: string;
  conversationId?: string;
  messageId?: string;
  rawUserMessage?: string; // FR-008 — identity-guard inspects the inbound user message as well as the reply
  config: T;
}

export interface InputValidator<T extends BaseValidatorConfig = BaseValidatorConfig> {
  name: string;
  validateAndMutate(input: string, context: ValidatorContext<T>): Promise<{
    verdict: Verdict;
    mutatedInput: string;
    latencyMs: number;
  }>;
}

export interface ResponseValidator<T extends BaseValidatorConfig = BaseValidatorConfig> {
  name: string;
  validateAndMutate(reply: string, context: ValidatorContext<T>): Promise<{
    verdict: Verdict;
    mutatedReply: string;
    latencyMs: number;
  }>;
}
