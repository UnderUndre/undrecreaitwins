export type TuningDraftStatus = 'generating' | 'ready' | 'failed' | 'activated' | 'superseded' | 'rolled-back';
export type TuningMethod = 'doc-extraction' | 'template-bootstrap' | 'interview' | 'self-tuner';
export type ConfidenceLevel = 'high' | 'medium' | 'low';
export type ReviewVerdict = 'approved' | 'rejected';
export type ProposalSignal = 'repeated_topic' | 'validation_failures' | 'block_rate_spike' | 'sentiment_shift';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface TuningDraft {
  id: string;
  tenantId: string;
  personaId: string;
  method: TuningMethod;
  status: TuningDraftStatus;
  confidence: ConfidenceLevel | null;
  systemPrompt: string | null;
  funnelConfig: Record<string, unknown> | null;
  validatorToggles: Record<string, boolean> | null;
  diffSections: Record<string, unknown> | null;
  previousSnapshot: PreviousSnapshot | null;
  signals: TuningProposal[] | null;
  error: string | null;
  reviewVerdict: ReviewVerdict | null;
  reviewNotes: string | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
}

export interface PreviousSnapshot {
  systemPrompt: string;
  traits: Record<string, unknown>;
  priorFunnelVersionId: string | null;
  priorValidatorToggles: Record<string, boolean>;
}

export interface DraftConfigOverlay {
  systemPrompt?: string;
  funnelConfig?: Record<string, unknown>;
  validatorToggles?: Record<string, boolean>;
}

export interface ExtractionOutput {
  systemPrompt: string;
  funnelStages: Array<{
    name: string;
    description: string;
    triggers: string[];
    slots: Array<{ name: string; type: string; question: string }>;
  }>;
  validatorToggles: Record<string, boolean>;
  confidence: 'high' | 'medium' | 'low';
}

export interface InterviewSession {
  personaId: string;
  currentQuestion: number;
  answers: Array<{
    questionId: string;
    question: string;
    answer: string;
    skipped: boolean;
  }>;
  total: number;
  skipped: string[];
  createdAt: number;
}

export interface TuningProposal {
  id: string;
  personaId: string;
  signal: ProposalSignal;
  description: string;
  riskLevel: RiskLevel;
  affectedConversations: number;
  suggestedAction: string;
  createdAt: string;
}
