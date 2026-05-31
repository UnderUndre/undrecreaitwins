export type ValidatorMode = 'active' | 'dry-run';

export type VerdictDecision =
  | 'pass'
  | 'append_disclaimer'
  | 'block'
  | 'strip'
  | 'no_op'
  | 'rewrite'
  | 'error';

/**
 * Base config shared by every validator — `mode` is always present.
 */
export interface BaseValidatorConfig {
  mode: ValidatorMode;
}

export type ValidatorConfig = BaseValidatorConfig;

export interface FalsePromiseConfig extends BaseValidatorConfig {
  minConfidence: number;
  timeoutMs: number;
  remediation: 'append_disclaimer' | 'block';
  disclaimerText?: string;
  blockFallbackMessage?: string;
  judgeModel?: string;
}

export interface FormatInjectionConfig extends BaseValidatorConfig {
  maxInputChars?: number;
}

export interface IdentityGuardConfig extends BaseValidatorConfig {
  fallbackMessage?: string;
  applyToTier1?: boolean;
  maxInputChars?: number;
}

export type AnyValidatorConfig =
  | FalsePromiseConfig
  | FormatInjectionConfig
  | IdentityGuardConfig;

export interface Verdict {
  decision: VerdictDecision;
  confidence?: number;
  reason?: string;
  matchedPatternClass?: string;
  matchedPatterns?: string[];
}

export interface ValidatorContext<T extends BaseValidatorConfig = BaseValidatorConfig> {
  tenantId: string;
  personaId: string;
  conversationId?: string;
  messageId?: string;
  rawUserMessage?: string;
  config: T;
}

export interface ValidatorRunResult {
  verdict: Verdict;
  mutatedText: string;
  latencyMs: number;
}

export interface InputValidator<T extends BaseValidatorConfig = BaseValidatorConfig> {
  name: string;
  validateAndMutate(input: string, context: ValidatorContext<T>): Promise<ValidatorRunResult>;
}

export interface ResponseValidator<T extends BaseValidatorConfig = BaseValidatorConfig> {
  name: string;
  validateAndMutate(reply: string, context: ValidatorContext<T>): Promise<ValidatorRunResult>;
}
