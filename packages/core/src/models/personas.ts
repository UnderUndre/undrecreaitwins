import {
  pgTable,
  text,
  timestamp,
  jsonb,
  bigint,
  uniqueIndex,
  index,
  real,
  boolean,
  integer,
} from 'drizzle-orm/pg-core';
import type { PersonaTraits, ModelPreferences } from '@undrecreaitwins/shared';

/** JSONB shape for pacing_config column (FR-012) */
export interface PacingConfig {
  baseDelayMs: number;
  typingIndicator: boolean;
  randomVariation: boolean;
}

export const personas = pgTable(
  'personas',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    traits: jsonb('traits').notNull().$type<PersonaTraits>().default({}),
    modelPreferences: jsonb('model_preferences')
      .notNull()
      .$type<ModelPreferences>()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    annotationSimilarityThreshold: real('annotation_similarity_threshold')
      .notNull()
      .default(0.7),
    hasAnnotations: boolean('has_annotations').notNull().default(false),
    agentEnabled: boolean('agent_enabled').notNull().default(false),
    toolAllowlist: jsonb('tool_allowlist').notNull().default([]),
    agentConfig: jsonb('agent_config').notNull().default({}),

    // --- Hybrid Agent Core: behavior columns (017-hybrid-agent-core) ---

    /** Fallback messages pool — JSON array of strings (FR-001). Default: empty. */
    fallbackMessages: jsonb('fallback_messages')
      .notNull()
      .default([]),

    /** Soft fallback threshold in ms (FR-001). Default 15s, valid range 3000–55000. */
    fallbackThresholdMs: integer('fallback_threshold_ms')
      .notNull()
      .default(15000),

    /** Enable strict RAG mode — refuse when no grounding chunks found (FR-010). */
    strictRag: boolean('strict_rag').notNull().default(false),

    /** Custom refusal message when strict RAG blocks. NULL = built-in localized default. */
    strictRagRefusal: text('strict_rag_refusal'),

    /** Per-persona relevance threshold for RAG retrieval (default 0.3). */
    ragRelevanceThreshold: real('rag_relevance_threshold')
      .notNull()
      .default(0.3),

    /** RAG mode: 'static' = auto-inject in prompt (Phase 1), 'tool' = search_docs tool (Phase 2). */
    ragMode: text('rag_mode').notNull().default('static'),

    /** Funnel generation mode: 'single' = 1 LLM call with structured output, 'dual' = 2 calls (FR-006). */
    funnelGeneration: text('funnel_generation').notNull().default('single'),

    /** Response pacing config (FR-012). baseDelayMs: 0=off, max 120000. */
    pacingConfig: jsonb('pacing_config')
      .notNull()
      .$type<PacingConfig>()
      .default({
        baseDelayMs: 0,
        typingIndicator: false,
        randomVariation: false,
      }),
  },
  (table) => ({
    tenantSlugIdx: uniqueIndex('personas_tenant_slug_idx').on(
      table.tenantId,
      table.slug,
    ),
    tenantIdx: index('personas_tenant_idx').on(table.tenantId),
  }),
);
