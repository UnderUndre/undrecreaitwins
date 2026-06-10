export const CHANNEL_TYPES = [
  'telegram',
  'whatsapp_evolution',
  'discord',
  'slack',
  'mattermost',
  'dingtalk',
  'feishu',
  'wecom',
  'matrix',
  'email',
  'sms',
  'webhook',
  'homeassistant',
  'vk',
  'avito',
] as const;

export const TRAINING_SOURCE_TYPES = ['telegram_json', 'whatsapp_txt', 'generic_jsonl'] as const;

export const TRAINING_JOB_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;

export const CHANNEL_STATUSES = ['active', 'degraded', 'disconnected', 'error'] as const;

export const RAG_COLLECTION_NAME = 'twin_engine_rag';

export const REDIS_STREAMS = {
  INBOUND: 'twin.stream.in',
  OUTBOUND: 'twin.stream.out',
  HEALTH: 'twin.stream.health',
  TRAINING: 'twin.stream.training',
} as const;

export const DEFAULT_RATE_LIMIT = {
  MAX_REQUESTS_PER_MINUTE: 60,
  MAX_TOKENS_PER_MINUTE: 100_000,
} as const;

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export const DEDUP_TTL_SECONDS = 300;
