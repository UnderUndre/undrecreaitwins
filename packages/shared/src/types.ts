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
  version: bigint;
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
