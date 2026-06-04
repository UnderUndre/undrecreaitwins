/**
 * resolution.ts — effective config resolution: assistant → tenant → platform.
 *
 * Pure function + types. Inject Drizzle db + tables for testability.
 *
 * Priority chain:
 *   1. Per-persona override (llmProviderConfig where enabled=true)
 *   2. Tenant-level default  (tenantLlmDefault where enabled=true)
 *   3. Platform default      (hardcoded / env-driven sentinel)
 */

import { eq, and } from 'drizzle-orm';
import pino from 'pino';
import {
  llmProviderConfig,
  tenantLlmDefault,
} from '../../models/llm-provider.js';

const logger = pino({ name: 'llm-provider-resolution' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields shared between per-assistant overrides and tenant defaults. */
export interface LLMProviderFields {
  providerType: string;
  baseUrl: string;
  modelId: string;
  apiKeyCiphertext: string;
  apiKeyRef: string;
  temperature: number | null;
  maxTokens: number | null;
  enabled: boolean;
}

/**
 * Resolved configuration tagged with its origin.
 * `platform` source → config is null (caller supplies platform default).
 */
export type EffectiveLLMConfig =
  | { source: 'assistant'; config: LLMProviderFields }
  | { source: 'tenant'; config: LLMProviderFields }
  | { source: 'platform'; config: null };

/** Map a Drizzle row (has extra cols like id, version, timestamps) to LLMProviderFields. */
function rowToFields(row: Record<string, unknown>): LLMProviderFields {
  return {
    providerType: row.providerType as string,
    baseUrl: row.baseUrl as string,
    modelId: row.modelId as string,
    apiKeyCiphertext: row.apiKeyCiphertext as string,
    apiKeyRef: row.apiKeyRef as string,
    temperature: (row.temperature as number | null) ?? null,
    maxTokens: (row.maxTokens as number | null) ?? null,
    enabled: row.enabled as boolean,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective LLM config for a given tenant + persona.
 *
 * @param db       Drizzle PgDatabase instance (typed as `any` for flexibility).
 * @param tenantId Tenant identifier.
 * @param personaId Persona (assistant) identifier.
 */
export async function resolveEffectiveConfig(
  db: any,
  tenantId: string,
  personaId: string,
): Promise<EffectiveLLMConfig> {
  // Phase 1 — per-assistant override
  const [override] = await db
    .select()
    .from(llmProviderConfig)
    .where(
      and(
        eq(llmProviderConfig.personaId, personaId),
        eq(llmProviderConfig.enabled, true),
      ),
    )
    .limit(1);

  if (override) {
    logger.debug({ personaId, source: 'assistant' }, 'resolved assistant override');
    return { source: 'assistant', config: rowToFields(override) };
  }

  // Phase 2 — tenant-level default
  const [tdefault] = await db
    .select()
    .from(tenantLlmDefault)
    .where(
      and(
        eq(tenantLlmDefault.tenantId, tenantId),
        eq(tenantLlmDefault.enabled, true),
      ),
    )
    .limit(1);

  if (tdefault) {
    logger.debug({ tenantId, source: 'tenant' }, 'resolved tenant default');
    return { source: 'tenant', config: rowToFields(tdefault) };
  }

  // Phase 3 — platform default (caller decides what this means)
  logger.debug({ tenantId, personaId, source: 'platform' }, 'falling back to platform default');
  return { source: 'platform', config: null };
}
