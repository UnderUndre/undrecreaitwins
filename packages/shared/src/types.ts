export interface Persona {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  systemPrompt: string;
  traits: PersonaTraits;
  modelPreferences: ModelPreferences;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface PersonaTraits {
  avg_sentence_length?: number;
  sentence_length_distribution?: number[];
  emoji_density?: number;
  emoji_top_used?: string[];
  top_phrases?: string[];
  formality_score?: number;
  response_latency_pattern?: number[];
  lexicon_size?: number;
  manual_lock?: string[];
  [key: string]: unknown;
}

export interface ModelPreferences {
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  fallback_model?: string;
  [key: string]: unknown;
}

export interface Conversation {
  id: string;
  tenantId: string;
  personaId: string;
  channelId?: string;
  externalUserId: string;
  summary?: string;
  startedAt: Date;
  endedAt?: Date;
  messageCount: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata: MessageMetadata;
  createdAt: Date;
}

export interface MessageMetadata {
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  [key: string]: unknown;
}

export interface ChannelInstance {
  id: string;
  tenantId: string;
  personaId: string;
  channelType: ChannelType;
  config: Record<string, unknown>;
  status: ChannelStatus;
  lastHealthCheckAt?: Date;
  createdAt: Date;
}

export type ChannelType = 'telegram' | 'whatsapp_evolution';

export type ChannelStatus = 'active' | 'degraded' | 'disconnected' | 'error';

export interface ChannelMessage {
  id: string;
  channelId: string;
  externalUserId: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: Date;
}

export interface ChannelHealth {
  status: ChannelStatus;
  lastPingAt?: Date;
  error?: string;
  uptimeSeconds?: number;
}

export interface ChannelAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onIncoming(handler: (message: ChannelMessage) => Promise<void>): void;
  send(message: ChannelMessage): Promise<void>;
  health(): Promise<ChannelHealth>;
}

export interface TrainingJob {
  id: string;
  tenantId: string;
  personaId: string;
  sourceType: TrainingSourceType;
  sourceFileRef: string;
  status: TrainingJobStatus;
  progressPercent: number;
  extractedTraits?: PersonaTraits;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

export type TrainingSourceType = 'telegram_json' | 'whatsapp_txt' | 'generic_jsonl';

export type TrainingJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface UsageEvent {
  id: string;
  tenantId: string;
  personaId: string;
  conversationId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  createdAt: Date;
}

export interface ApiToken {
  id: string;
  tenantId: string;
  name: string;
  tokenHash: string;
  createdAt: Date;
  revokedAt?: Date;
}

// --- Funnel System ---

export interface FunnelDefinition {
  id: string;
  tenantId: string;
  personaId: string;
  name: string;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FunnelVersion {
  id: string;
  definitionId: string;
  versionNumber: number;
  config: FunnelConfig;
  isActive: boolean;
  createdAt: Date;
}

export interface FunnelConfig {
  relevance_threshold: number;
  off_script_behavior: 'steer' | 'abstain' | 'catch_all';
  catch_all_fragment_id?: string;
  stuck_threshold: number;
  stuck_action: 'yield_generation' | 'handoff' | 'exit_stage';
  scoring_weights: ScoringWeights;
}

export interface ScoringWeights {
  exact_match: number;
  stemmed_match: number;
  synonym_match: number;
  stage_boost: number;
  next_stage_bonus: number;
  objection_boost: number;
}

export interface FunnelStage {
  id: string;
  funnelVersionId: string;
  name: string;
  order: number;
  objective?: string;
  resolutionCriteria: ResolutionCriteria;
  nextStageId?: string;
  stuckAction?: 'yield_generation' | 'handoff' | 'exit_stage';
  exitStageId?: string;
}

export type ResolutionCriteria =
  | { type: 'fragment_selected'; fragment_id: string }
  | { type: 'slot_filled'; slot_name: string }
  | { type: 'all_slots_filled' };

export interface FunnelFragment {
  id: string;
  funnelVersionId: string;
  stageId: string;
  type: 'normal' | 'objection';
  content: string;
  triggers: TriggerDefinition;
  scoreWeight: number;
}

export interface TriggerDefinition {
  phrases?: string[];
  synonyms?: Record<string, string[]>;
}

export interface FunnelSlot {
  id: string;
  funnelVersionId: string;
  stageId?: string;
  name: string;
  description?: string;
  validationRules?: Record<string, unknown>;
}

export interface FullFunnel extends FunnelVersion {
  definition: FunnelDefinition;
  stages: (FunnelStage & { fragments: FunnelFragment[] })[];
  slots: FunnelSlot[];
}

export interface ConversationFunnelState {
  conversationId: string;
  funnelVersionId: string;
  currentStageId: string;
  consecutiveStuckCount: number;
  capturedSlots: Record<string, CapturedSlot>;
  version: number;
  updatedAt: Date;
}

export interface CapturedSlot {
  value: unknown;
  verified: boolean;
  captured_at: string; // ISO8601
}

export interface FunnelSelectionMetadata {
  fragment_id?: string;
  score?: number;
  type: 'scripted' | 'steer' | 'abstain' | 'catch_all' | 'no_funnel';
  signals?: Record<string, number>;
  stage_transition?: {
    from: string;
    to: string;
    type: 'advance' | 'regression' | 'stay';
  };
}
