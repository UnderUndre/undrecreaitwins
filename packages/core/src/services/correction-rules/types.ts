import type { QualityVerdict } from '../../types/quality-event.js';

export type { QualityVerdict };

export interface RubricItem {
  id: string;
  text: string;
  required: boolean;
}

export type DetectorConfig =
  | { type: 'regex'; config: { pattern: string; flags?: string } }
  | { type: 'keyword'; config: { words: string[]; matchAll?: boolean } }
  | { type: 'pattern'; config: { description: string } }
  | { type: 'semantic'; config: { prompt: string; rubricItems?: RubricItem[] } };

export interface CorrectionRule {
  id: string;
  tenantId: string;
  assistantId: string | null;
  name: string;
  detector: DetectorConfig;
  rewriteInstruction: string | null;
  mode: 'rewrite' | 'score';
  priority: number;
  scope: 'sentence' | 'paragraph' | 'full';
  turnScope: 'single' | 'conversation' | null;
  isEnabled: boolean;
  rubricItems: RubricItem[] | null;
}

export interface QualityEventPush {
  assistantId: string;
  ruleId: string;
  ruleName: string;
  conversationId: string | null;
  messageId: string | null;
  mode: 'rewrite' | 'score';
  verdict: QualityVerdict;
  originalText?: string;
  rewrittenText?: string;
  score?: number;
  latencyMs: number;
  rolledBack: boolean;
  idempotencyKey: string;
  snapshotVersion: string;
}

export interface RuleCacheEntry {
  rules: CorrectionRule[];
  snapshotVersion: string;
  fetchedAt: number;
}

export interface DetectorResult {
  triggered: boolean;
  score?: number;
  latencyMs: number;
}

export interface Detector {
  detect(text: string, rule: CorrectionRule): Promise<DetectorResult>;
}

export interface DARResult {
  text: string;
  events: QualityEventPush[];
  latencyMs: number;
  stages: {
    detect: { triggered: number; skipped: number };
    aggregate: { rewriteCapped: number; overflowSkipped: number };
    rewrite?: { latencyMs: number };
    revalidation?: { verdict: 'pass' | 'fail'; rolledBack: boolean };
  };
}

export interface AggregatorOutput {
  rewriteRules: CorrectionRule[];
  scoreRules: CorrectionRule[];
  overflowSkipped: CorrectionRule[];
}
