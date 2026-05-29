// specs/004-validators/contracts/validator.ts

export type ValidatorMode = 'active' | 'dry-run';
export type VerdictDecision = 'pass' | 'append_disclaimer' | 'block' | 'strip' | 'no_op';

export interface ValidatorConfig {
  mode: ValidatorMode;
  [key: string]: any;
}

export interface FalsePromiseConfig extends ValidatorConfig {
  minConfidence: number;
  timeoutMs: number;
  remediation: 'append_disclaimer' | 'block';
}

export interface Verdict {
  decision: VerdictDecision;
  confidence?: number;
  reason?: string;
  matchedPatternClass?: string;
}

export interface ValidatorContext {
  tenantId: string;
  personaId: string;
  conversationId?: string;
  messageId?: string;
  config: ValidatorConfig;
}

export interface InputValidator {
  name: string;
  validateAndMutate(input: string, context: ValidatorContext): Promise<{
    verdict: Verdict;
    mutatedInput: string;
    latencyMs: number;
  }>;
}

export interface ResponseValidator {
  name: string;
  validateAndMutate(reply: string, context: ValidatorContext): Promise<{
    verdict: Verdict;
    mutatedReply: string;
    latencyMs: number;
  }>;
}
