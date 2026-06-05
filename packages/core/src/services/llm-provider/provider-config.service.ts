/**
 * ProviderConfigService — CRUD for llm_provider_config + tenant_llm_default.
 *
 * - Upsert / get / delete tenant-default + assistant-override
 * - Write-only API key (encrypt via crypto.ts)
 * - Optimistic-lock via version col
 * - Masked key responses (never return plaintext)
 * - Tenant isolation enforced (IDOR protection)
 */

import { eq, and } from 'drizzle-orm';
/* db type imported as `any` — follows resolution.ts pattern */
import pino from 'pino';
import {
  llmProviderConfig,
  tenantLlmDefault,
} from '../../models/llm-provider.js';
import {
  encryptApiKey,
  decryptApiKey,
  type KmsEnvelopeResult,
} from './crypto.js';
import { assertUrlAllowed } from './ssrf-guard.js';

const logger = pino({ name: 'provider-config-service' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input payload for creating/updating a provider config. */
export interface ProviderConfigInput {
  providerType: string;
  baseUrl: string;
  modelId: string;
  apiKey: string; // plaintext — encrypted before storage
  temperature?: number | null;
  maxTokens?: number | null;
  enabled?: boolean;
  /** Optimistic-lock: must match current `version` or 409. Omit for create. */
  expectedVersion?: number;
}

/** Masked API key — safe to return in responses. */
export interface MaskedApiKey {
  /** First 4 + last 4 chars of plaintext key, middle masked. */
  masked: string;
  /** KMS key reference for rotation tracking. */
  keyRef: string;
}

/** Response shape — never contains plaintext key or ciphertext. */
export interface ProviderConfigResponse {
  id: string;
  tenantId: string;
  personaId?: string;
  providerType: string;
  baseUrl: string;
  modelId: string;
  apiKey: MaskedApiKey;
  temperature: number | null;
  maxTokens: number | null;
  enabled: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mask a plaintext key: "sk-a...wxyz" pattern. */
function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) {
    return '*'.repeat(plaintext.length);
  }
  const head = plaintext.slice(0, 4);
  const tail = plaintext.slice(-4);
  const stars = '*'.repeat(Math.min(plaintext.length - 8, 8));
  return `${head}${stars}${tail}`;
}

/** Shared column list for select (excludes ciphertext from default projection). */
const providerConfigCols = {
  id: llmProviderConfig.id,
  tenantId: llmProviderConfig.tenantId,
  personaId: llmProviderConfig.personaId,
  providerType: llmProviderConfig.providerType,
  baseUrl: llmProviderConfig.baseUrl,
  modelId: llmProviderConfig.modelId,
  apiKeyCiphertext: llmProviderConfig.apiKeyCiphertext,
  apiKeyRef: llmProviderConfig.apiKeyRef,
  temperature: llmProviderConfig.temperature,
  maxTokens: llmProviderConfig.maxTokens,
  enabled: llmProviderConfig.enabled,
  version: llmProviderConfig.version,
  createdAt: llmProviderConfig.createdAt,
  updatedAt: llmProviderConfig.updatedAt,
};

const tenantDefaultCols = {
  id: tenantLlmDefault.id,
  tenantId: tenantLlmDefault.tenantId,
  providerType: tenantLlmDefault.providerType,
  baseUrl: tenantLlmDefault.baseUrl,
  modelId: tenantLlmDefault.modelId,
  apiKeyCiphertext: tenantLlmDefault.apiKeyCiphertext,
  apiKeyRef: tenantLlmDefault.apiKeyRef,
  temperature: tenantLlmDefault.temperature,
  maxTokens: tenantLlmDefault.maxTokens,
  enabled: tenantLlmDefault.enabled,
  version: tenantLlmDefault.version,
  createdAt: tenantLlmDefault.createdAt,
  updatedAt: tenantLlmDefault.updatedAt,
};

/**
 * Build a masked response from a full DB row.
 * Decrypts key only to derive the masked form — plaintext is never exposed.
 */
async function toMaskedResponse(
  row: Record<string, unknown>,
  personaId?: string,
): Promise<ProviderConfigResponse> {
  const plaintext = await decryptApiKey(
    row.apiKeyCiphertext as string,
    row.apiKeyRef as string,
  );

  return {
    id: row.id as string,
    tenantId: row.tenantId as string,
    ...(personaId !== undefined ? { personaId } : {}),
    providerType: row.providerType as string,
    baseUrl: row.baseUrl as string,
    modelId: row.modelId as string,
    apiKey: {
      masked: maskKey(plaintext),
      keyRef: row.apiKeyRef as string,
    },
    temperature: (row.temperature as number | null) ?? null,
    maxTokens: (row.maxTokens as number | null) ?? null,
    enabled: row.enabled as boolean,
    version: row.version as number,
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OptimisticLockError extends Error {
  public readonly name = 'OptimisticLockError';
  constructor(
    public readonly table: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `${table}: expected version ${expected}, got ${actual}. Concurrent update detected.`,
    );
    Object.setPrototypeOf(this, OptimisticLockError.prototype);
  }
}

export class ConfigNotFoundError extends Error {
  public readonly name = 'ConfigNotFoundError';
  constructor(public readonly table: string, public readonly key: string) {
    super(`${table}: no record found for ${key}`);
    Object.setPrototypeOf(this, ConfigNotFoundError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ProviderConfigService {
  constructor(
    private readonly db: typeof import('../../db.js').db,
  ) {}

  // ── Tenant default ────────────────────────────────────────────────────

  /**
   * Get tenant-level default provider config.
   * Returns null if no default configured.
   */
  async getTenantDefault(tenantId: string): Promise<ProviderConfigResponse | null> {
    const [row] = await this.db
      .select(tenantDefaultCols)
      .from(tenantLlmDefault)
      .where(eq(tenantLlmDefault.tenantId, tenantId))
      .limit(1);

    if (!row) return null;
    return toMaskedResponse(row as Record<string, unknown>);
  }

  /**
   * Upsert tenant-level default provider config.
   * If a row exists for this tenant, updates it (with optimistic lock).
   * If no row exists, creates one.
   * SSRF-checks the baseUrl before persisting.
   */
  async upsertTenantDefault(
    tenantId: string,
    input: ProviderConfigInput,
  ): Promise<ProviderConfigResponse> {
    // SSRF guard
    const ssrfResult = await assertUrlAllowed(input.baseUrl);
    if (!ssrfResult.allowed) {
      throw new Error(`baseUrl rejected: ${ssrfResult.reason}`);
    }

    // Encrypt API key
    const encrypted: KmsEnvelopeResult = await encryptApiKey(input.apiKey);

    // Check for existing row
    const [existing] = await this.db
      .select({ id: tenantLlmDefault.id, version: tenantLlmDefault.version })
      .from(tenantLlmDefault)
      .where(eq(tenantLlmDefault.tenantId, tenantId))
      .limit(1);

    if (existing) {
      // Optimistic lock check
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== existing.version
      ) {
        throw new OptimisticLockError(
          'tenant_llm_default',
          input.expectedVersion,
          existing.version,
        );
      }

      await this.db
        .update(tenantLlmDefault)
        .set({
          providerType: input.providerType,
          baseUrl: input.baseUrl,
          modelId: input.modelId,
          apiKeyCiphertext: encrypted.ciphertext,
          apiKeyRef: encrypted.keyRef,
          temperature: input.temperature ?? null,
          maxTokens: input.maxTokens ?? null,
          enabled: input.enabled ?? true,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(tenantLlmDefault.id, existing.id));

      logger.info(
        { tenantId, version: existing.version + 1 },
        'upsertTenantDefault: updated',
      );

      // Re-fetch for consistent response
      const [updated] = await this.db
        .select(tenantDefaultCols)
        .from(tenantLlmDefault)
        .where(eq(tenantLlmDefault.id, existing.id))
        .limit(1);

      return toMaskedResponse(updated as Record<string, unknown>);
    }

    // Insert new
    const [inserted] = await this.db
      .insert(tenantLlmDefault)
      .values({
        tenantId,
        providerType: input.providerType,
        baseUrl: input.baseUrl,
        modelId: input.modelId,
        apiKeyCiphertext: encrypted.ciphertext,
        apiKeyRef: encrypted.keyRef,
        temperature: input.temperature ?? null,
        maxTokens: input.maxTokens ?? null,
        enabled: input.enabled ?? true,
        version: 0,
      })
      .returning();

    logger.info({ tenantId }, 'upsertTenantDefault: created');

    return toMaskedResponse(inserted as Record<string, unknown>);
  }

  /**
   * Delete tenant-level default config.
   * Returns true if a row was deleted, false if not found.
   */
  async deleteTenantDefault(tenantId: string): Promise<boolean> {
    const result = await this.db
      .delete(tenantLlmDefault)
      .where(eq(tenantLlmDefault.tenantId, tenantId))
      .returning({ id: tenantLlmDefault.id });

    const deleted = result.length > 0;
    if (deleted) {
      logger.info({ tenantId }, 'deleteTenantDefault: deleted');
    }
    return deleted;
  }

  // ── Assistant override ────────────────────────────────────────────────

  /**
   * Get per-assistant (persona) provider config override.
   * Returns null if no override configured.
   */
  async getAssistantOverride(tenantId: string, personaId: string): Promise<ProviderConfigResponse | null> {
    const [row] = await this.db
      .select(providerConfigCols)
      .from(llmProviderConfig)
      .where(
        and(
          eq(llmProviderConfig.tenantId, tenantId),
          eq(llmProviderConfig.personaId, personaId)
        )
      )
      .limit(1);

    if (!row) return null;
    return toMaskedResponse(row as Record<string, unknown>, personaId);
  }

  /**
   * Upsert per-assistant provider config override.
   * If a row exists for this personaId, updates it (with optimistic lock).
   * If no row exists, creates one.
   * SSRF-checks the baseUrl before persisting.
   */
  async upsertAssistantOverride(
    tenantId: string,
    personaId: string,
    input: ProviderConfigInput,
  ): Promise<ProviderConfigResponse> {
    // SSRF guard
    const ssrfResult = await assertUrlAllowed(input.baseUrl);
    if (!ssrfResult.allowed) {
      throw new Error(`baseUrl rejected: ${ssrfResult.reason}`);
    }

    // Encrypt API key
    const encrypted: KmsEnvelopeResult = await encryptApiKey(input.apiKey);

    // Check for existing row (enforce tenant isolation)
    const [existing] = await this.db
      .select({ id: llmProviderConfig.id, version: llmProviderConfig.version })
      .from(llmProviderConfig)
      .where(
        and(
          eq(llmProviderConfig.tenantId, tenantId),
          eq(llmProviderConfig.personaId, personaId)
        )
      )
      .limit(1);

    if (existing) {
      // Optimistic lock check
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== existing.version
      ) {
        throw new OptimisticLockError(
          'llm_provider_config',
          input.expectedVersion,
          existing.version,
        );
      }

      await this.db
        .update(llmProviderConfig)
        .set({
          providerType: input.providerType,
          baseUrl: input.baseUrl,
          modelId: input.modelId,
          apiKeyCiphertext: encrypted.ciphertext,
          apiKeyRef: encrypted.keyRef,
          temperature: input.temperature ?? null,
          maxTokens: input.maxTokens ?? null,
          enabled: input.enabled ?? true,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(llmProviderConfig.id, existing.id));

      logger.info(
        { tenantId, personaId, version: existing.version + 1 },
        'upsertAssistantOverride: updated',
      );

      // Re-fetch for consistent response
      const [updated] = await this.db
        .select(providerConfigCols)
        .from(llmProviderConfig)
        .where(eq(llmProviderConfig.id, existing.id))
        .limit(1);

      return toMaskedResponse(
        updated as Record<string, unknown>,
        personaId,
      );
    }

    // Insert new
    const [inserted] = await this.db
      .insert(llmProviderConfig)
      .values({
        tenantId,
        personaId,
        providerType: input.providerType,
        baseUrl: input.baseUrl,
        modelId: input.modelId,
        apiKeyCiphertext: encrypted.ciphertext,
        apiKeyRef: encrypted.keyRef,
        temperature: input.temperature ?? null,
        maxTokens: input.maxTokens ?? null,
        enabled: input.enabled ?? true,
        version: 0,
      })
      .returning();

    logger.info({ tenantId, personaId }, 'upsertAssistantOverride: created');

    return toMaskedResponse(
      inserted as Record<string, unknown>,
      personaId,
    );
  }

  /**
   * Delete per-assistant provider config override.
   * Returns true if a row was deleted, false if not found.
   */
  async deleteAssistantOverride(tenantId: string, personaId: string): Promise<boolean> {
    const result = await this.db
      .delete(llmProviderConfig)
      .where(
        and(
          eq(llmProviderConfig.tenantId, tenantId),
          eq(llmProviderConfig.personaId, personaId)
        )
      )
      .returning({ id: llmProviderConfig.id });

    const deleted = result.length > 0;
    if (deleted) {
      logger.info({ tenantId, personaId }, 'deleteAssistantOverride: deleted');
    }
    return deleted;
  }

  // ── Internal ─────────────────────────────────────────────────────────

  /**
   * Get the decrypted API key for a tenant default.
   * Internal use only (e.g., test-connection merge).
   */
  async getDecryptedTenantKey(tenantId: string): Promise<string | null> {
    const [row] = await this.db
      .select({
        apiKeyCiphertext: tenantLlmDefault.apiKeyCiphertext,
        apiKeyRef: tenantLlmDefault.apiKeyRef,
      })
      .from(tenantLlmDefault)
      .where(eq(tenantLlmDefault.tenantId, tenantId))
      .limit(1);

    if (!row) return null;
    return decryptApiKey(row.apiKeyCiphertext, row.apiKeyRef);
  }

  /**
   * Get the decrypted API key for an assistant override.
   * Internal use only (e.g., test-connection merge).
   */
  async getDecryptedAssistantKey(tenantId: string, personaId: string): Promise<string | null> {
    const [row] = await this.db
      .select({
        apiKeyCiphertext: llmProviderConfig.apiKeyCiphertext,
        apiKeyRef: llmProviderConfig.apiKeyRef,
      })
      .from(llmProviderConfig)
      .where(
        and(
          eq(llmProviderConfig.tenantId, tenantId),
          eq(llmProviderConfig.personaId, personaId)
        )
      )
      .limit(1);

    if (!row) return null;
    return decryptApiKey(row.apiKeyCiphertext, row.apiKeyRef);
  }
}
