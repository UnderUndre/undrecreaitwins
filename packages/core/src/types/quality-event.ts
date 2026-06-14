export type QualityVerdict =
  | 'pass'
  | 'strip'
  | 'block'
  | 'fail'
  | 'rewritten'
  | 'rolled_back'
  | 'overflow_skipped';

export type QualityEventSource =
  | '004-false-promise'
  | '004-identity-guard'
  | '017-language-guard'
  | '018-dar-pipeline';

export type QualityEventMode = 'active' | 'dry-run' | 'rewrite' | 'score';

export interface QualityEvent {
  verdict: QualityVerdict;
  source: QualityEventSource;
  tenantId: string;
  personaId: string;
  conversationId: string | null;
  messageId: string | null;
  mode: QualityEventMode;
  isDryRun: boolean;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}
