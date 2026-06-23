export type RuleKind = 'system' | 'custom';
export type RuleMode = 'active' | 'dry-run';
export type VerdictCoarse = 'pass' | 'block' | 'warn' | 'corrected';
export type VerdictDetail =
  | 'translated'
  | 'regenerated'
  | 'rewritten'
  | 'rolled_back'
  | 'stripped'
  | 'degraded'
  | 'skipped';

export interface UnifiedRule {
  key: string;
  kind: RuleKind;
  enabled: boolean;
  mode?: RuleMode;
  terminalOnFail: boolean;
  priority: number;
  validatorType?: 'language-guard' | 'false-promise' | 'identity-guard';
  detector?: import('../services/correction-rules/types.js').DetectorConfig;
  rewriteInstruction?: string;
  customRuleMode?: 'rewrite' | 'score';
  scope?: 'sentence' | 'paragraph' | 'full';
  turnScope?: 'single' | 'conversation' | null;
  rubricItems?: import('../services/correction-rules/types.js').RubricItem[];
  assistantId?: string | null;
  version: number;
  updatedAt: Date;
}

export interface QualityEventPush {
  ts: Date;
  kind: RuleKind;
  ruleKey: string;
  verdict: VerdictCoarse;
  detail?: VerdictDetail;
  shortCircuitedBy?: string;
  conversationId: string;
  messageId?: string;
  latencyMs?: number;
  score?: number;
  sourceLang?: string;
  targetLang?: string;
  idempotencyKey: string;
  assistantId: string;
  originalText?: string;
  rewrittenText?: string;
  ruleId?: string;
  ruleName?: string;
  snapshotVersion?: string;
  legacyMode?: string;
  rolledBack?: boolean;
}

export interface RulesReloadPush {
  version: number;
  snapshotVersion: string;
  tenantId: string;
  personaId: string;
  rules: UnifiedRule[];
  pushedAt: Date;
}

export interface ResponseGuardContext {
  conversationId: string;
  messageId?: string;
  tenantId: string;
  personaId: string;
  rawUserMessage?: string;
  systemPrompt?: string;
  regenerateFn?: (reinforcedSystemPrompt: string) => Promise<string>;
  degradeToAsIs?: boolean;
}

export interface ResponseGuardStageResult {
  verdict: VerdictCoarse;
  detail?: VerdictDetail;
  rewrittenText?: string;
  shortCircuitedBy?: string;
  score?: number;
  latencyMs: number;
}

export interface ResponseGuardResult {
  response: string;
  verdict: VerdictCoarse;
  detail?: VerdictDetail;
  shortCircuitedBy?: string;
  events: QualityEventPush[];
  latencyMs: number;
}

export interface RuleCacheEntry {
  version: number;
  snapshotVersion: string;
  tenantId: string;
  personaId: string;
  rules: UnifiedRule[];
  rulesByKey: Map<string, UnifiedRule>;
  rulesByPriority: Map<number, UnifiedRule>;
  loadedAt: Date;
  pushedAt: Date;
}
