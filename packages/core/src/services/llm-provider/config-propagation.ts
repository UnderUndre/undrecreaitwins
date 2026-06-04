/**
 * config-propagation.ts — Verify config changes propagate to queued retries (T017).
 *
 * DESIGN: The retry worker (T013) calls resolveEffectiveConfig() on EVERY attempt,
 * which re-queries the DB for the current config version. This means:
 * - Key rotation: new ciphertext/keyRef picked up on next retry attempt
 * - Model change: new modelId used on next retry attempt
 * - Provider change: new baseUrl/providerType used on next retry attempt
 * - SSRF re-check: DNS re-resolved on every attempt (DNS may have changed)
 *
 * This module provides verification hooks and metrics for observability.
 */

import pino from 'pino';
import { db } from '../../db.js';
import { resolveEffectiveConfig } from './resolution.js';
import { assertUrlAllowed } from './ssrf-guard.js';

const logger = pino({ name: 'config-propagation' });

// ---------------------------------------------------------------------------
// Verification: confirm re-resolution returns different config after change
// ---------------------------------------------------------------------------

export interface ConfigPropagationCheck {
  tenantId: string;
  personaId: string;
  /** Config version at the time of check */
  configVersion: number | null;
  /** Source of config: 'platform' | 'tenant_default' | 'persona_override' */
  source: string;
  /** Whether the config differs from the provided baseline */
  changed: boolean;
  /** SHA-256 hash of the effective config (baseUrl + modelId + keyRef) */
  configHash: string;
  timestamp: string;
}

/**
 * Verify that the current effective config for a tenant/persona differs from
 * a previously-known baseline. Used by retry worker to detect config drift.
 */
export async function verifyConfigPropagation(
  tenantId: string,
  personaId: string,
  previousConfigHash: string,
): Promise<ConfigPropagationCheck> {
  const effective = await resolveEffectiveConfig(db, tenantId, personaId);

  let configHash: string;
  let configVersion: number | null = null;

  if (effective.source !== 'platform' && effective.config) {
    const { createHash } = await import('node:crypto');
    configHash = createHash('sha256')
      .update(`${effective.config.baseUrl}|${effective.config.modelId}|${effective.config.apiKeyRef}`)
      .digest('hex');
  } else {
    configHash = 'platform-default';
  }

  const changed = configHash !== previousConfigHash;

  if (changed) {
    logger.info(
      {
        tenantId,
        personaId,
        previousConfigHash,
        newConfigHash: configHash,
        source: effective.source,
        configVersion,
      },
      'verifyConfigPropagation: config changed since last resolution',
    );
  }

  return {
    tenantId,
    personaId,
    configVersion,
    source: effective.source,
    changed,
    configHash,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Metrics: how often re-resolution yields changed config
// ---------------------------------------------------------------------------

let totalReResolutions = 0;
let changedReResolutions = 0;

export function recordReResolution(changed: boolean): void {
  totalReResolutions++;
  if (changed) changedReResolutions++;
}

export function getPropagationMetrics(): {
  total: number;
  changed: number;
  changeRate: number;
} {
  return {
    total: totalReResolutions,
    changed: changedReResolutions,
    changeRate: totalReResolutions > 0 ? changedReResolutions / totalReResolutions : 0,
  };
}
