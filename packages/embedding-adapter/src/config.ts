import { z } from 'zod';

const EmbeddingProvider = z.enum(['openai', 'jina']);
const RerankProvider = z.enum(['cohere', 'jina']);

export const AdapterConfig = z.object({
  // Server
  PORT: z.coerce.number().default(8095),
  HOST: z.string().default('0.0.0.0'),

  // Embedding provider
  EMBEDDING_PROVIDER: EmbeddingProvider.default('jina'),
  EMBEDDING_MODEL: z.string().optional(),

  // Rerank provider
  RERANK_PROVIDER: RerankProvider.default('jina'),
  RERANK_MODEL: z.string().optional(),

  // API Keys
  OPENAI_API_KEY: z.string().optional(),
  COHERE_API_KEY: z.string().optional(),
  JINA_API_KEY: z.string().optional(),

  // Custom OpenAI compatible endpoint URL
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),

  // Upstream timeout
  UPSTREAM_TIMEOUT_MS: z.coerce.number().default(10_000),

  // Circuit breaker
  CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().default(5),
  CIRCUIT_RESET_TIMEOUT: z.coerce.number().default(30),

  // Concurrency limit
  MAX_CONCURRENT_REQUESTS: z.coerce.number().default(50),

  // Input size guard
  MAX_INPUT_CHARS: z.coerce.number().default(8192),

  // Fastify body limit in bytes
  BODY_LIMIT: z.coerce.number().default(9_000_000),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type AdapterConfig = z.infer<typeof AdapterConfig>;

// Parse process.env with default values and validate
export const config = AdapterConfig.parse(process.env);
