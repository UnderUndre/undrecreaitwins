/**
 * LLM Provider Configuration service — per-assistant provider config (011).
 *
 * Exports: resolution, crypto, SSRF guard, test-connection, provider-config service,
 *          secret audit, SSRF audit, config propagation.
 */
export { resolveEffectiveConfig, type EffectiveLLMConfig } from './resolution.js';
export { encryptApiKey, decryptApiKey, type KmsEnvelopeResult } from './crypto.js';
export { assertUrlAllowed, isPrivateIp, createPinnedDnsLookup, type SsrfCheckResult } from './ssrf-guard.js';
export { ProviderConfigService } from './provider-config.service.js';
export {
  SECRET_REDACT_PATHS, REDACT_REPLACEMENT, createSecureLogger,
  assertNoSecretsInOutput, assertNoSecretsInObject,
  trackDecryption, getDecryptionMetrics,
} from './secret-audit.js';
export {
  ssrfSafeFetch, recordSsrfAudit, getSsrfAuditLog,
  assertDnsPinningWorks, assertSsrfBlocksPrivateUrls,
} from './ssrf-audit.js';
export {
  verifyConfigPropagation, recordReResolution, getPropagationMetrics,
  type ConfigPropagationCheck,
} from './config-propagation.js';
