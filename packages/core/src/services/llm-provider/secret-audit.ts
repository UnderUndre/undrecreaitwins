/**
 * secret-audit.ts — Runtime secret-handling enforcement (T015 / US4).
 *
 * Provides:
 * 1. Pino redact paths for structured log scrubbing
 * 2. Runtime assertion that decrypted keys never appear in log output
 * 3. Typed wrapper that ensures decrypt-only-at-injection semantics
 *
 * DESIGN: Defense-in-depth. Even if a developer accidentally passes apiKey
 * to a logger, the redact config strips it. The assertKeyNotInOutput() hook
 * can be called in test suites to verify at runtime.
 */

import pino from 'pino';

// ---------------------------------------------------------------------------
// Redact configuration — apply to ALL pino loggers in the service layer
// ---------------------------------------------------------------------------

/**
 * Pino redact paths. Add to every pino instance via:
 *   pino({ redact: SECRET_REDACT_PATHS })
 *
 * These paths match both top-level and nested properties.
 */
export const SECRET_REDACT_PATHS: string[] = [
  'apiKey',
  'api_key',
  'apiSecret',
  'api_secret',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'password',
  'secret',
  'authorization',
  'HERMES_API_KEY',
  'HERMES_BASE_URL', // may contain embedded credentials
  'ciphertext',
  'plaintext',
  // Nested paths
  'config.apiKey',
  'config.api_key',
  'headers.authorization',
  'headers.Authorization',
  'env.HERMES_API_KEY',
  'err.config.apiKey',
  // request/response bodies that might contain keys
  'body.apiKey',
  'body.api_key',
  'body.authorization',
];

/** Standard redact serializer string (replaced with this) */
export const REDACT_REPLACEMENT = '[REDACTED]';

/**
 * Create a pino instance with secret-redaction enabled.
 * Use this instead of raw `pino()` everywhere in services.
 */
export function createSecureLogger(options: pino.LoggerOptions = {}): pino.Logger {
  return pino({
    ...options,
    redact: {
      paths: SECRET_REDACT_PATHS,
      censor: REDACT_REPLACEMENT,
    },
  });
}

// ---------------------------------------------------------------------------
// Runtime assertion — for test suites and health checks
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,       // OpenAI-style keys
  /sk_live_[a-zA-Z0-9]{20,}/,  // Stripe-style live keys
  /sk_test_[a-zA-Z0-9]{20,}/,  // Stripe-style test keys
  /key-[a-zA-Z0-9]{20,}/,      // Generic key patterns
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i, // Bearer tokens
  /local:[A-Za-z0-9+/=]{10,}/, // LocalKmsProvider ciphertext (base64)
];

/**
 * Assert that a string does NOT contain any known secret patterns.
 * Use in test assertions for log output, trace payloads, error messages.
 *
 * @throws Error if a secret pattern is detected
 */
export function assertNoSecretsInOutput(output: string, context?: string): void {
  for (const pattern of SENSITIVE_PATTERNS) {
    const match = pattern.exec(output);
    if (match) {
      throw new Error(
        `SECRET LEAK DETECTED${context ? ` in ${context}` : ''}: ` +
        `matched pattern ${pattern.source} in output. ` +
        `First 3 chars of match: "${match[0].slice(0, 3)}..."`,
      );
    }
  }
}

/**
 * Assert that a structured log object does not contain any sensitive keys.
 * Checks top-level and one level of nesting.
 */
export function assertNoSecretsInObject(obj: Record<string, unknown>, context?: string): void {
  const sensitiveKeys = new Set([
    'apiKey', 'api_key', 'apiSecret', 'api_secret',
    'accessToken', 'access_token', 'password', 'secret',
    'ciphertext', 'plaintext', 'authorization', 'Authorization',
    'HERMES_API_KEY',
  ]);

  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.has(key) && typeof value === 'string' && value.length > 0) {
      throw new Error(
        `SECRET LEAK DETECTED${context ? ` in ${context}` : ''}: ` +
        `sensitive key "${key}" present in log object with non-empty value`,
      );
    }

    // Check one level of nesting
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (sensitiveKeys.has(nestedKey) && typeof nestedValue === 'string' && nestedValue.length > 0) {
          throw new Error(
            `SECRET LEAK DETECTED${context ? ` in ${context}` : ''}: ` +
            `sensitive key "${key}.${nestedKey}" present in log object with non-empty value`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Decrypt-only-at-injection enforcement wrapper
// ---------------------------------------------------------------------------

let decryptionCount = 0;
const MAX_DECRYPTIONS_PER_MINUTE = 200;
const decryptionTimestamps: number[] = [];

/**
 * Track a decryption event. If decryption rate exceeds threshold,
 * it suggests keys are being decrypted too frequently (potential leak path).
 * This is a monitoring/observability hook — it does NOT block decryption.
 */
export function trackDecryption(keyRef: string): void {
  const now = Date.now();
  decryptionTimestamps.push(now);
  decryptionCount++;

  // Prune timestamps older than 1 minute
  const oneMinuteAgo = now - 60_000;
  while (decryptionTimestamps.length > 0 && (decryptionTimestamps[0] ?? 0) < oneMinuteAgo) {
    decryptionTimestamps.shift();
  }

  if (decryptionTimestamps.length > MAX_DECRYPTIONS_PER_MINUTE) {
    // Use a dedicated audit logger (not the main app logger to avoid redact overhead)
    const auditLogger = pino({ name: 'secret-audit', redact: { paths: SECRET_REDACT_PATHS, censor: REDACT_REPLACEMENT } });
    auditLogger.error(
      {
        keyRef,
        decryptionRateLastMinute: decryptionTimestamps.length,
        threshold: MAX_DECRYPTIONS_PER_MINUTE,
      },
      'SECRET-AUDIT: decryption rate exceeds threshold — investigate potential key material leak',
    );
  }
}

/**
 * Get current decryption metrics for health checks / dashboards.
 */
export function getDecryptionMetrics(): { total: number; lastMinuteRate: number } {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  const recentCount = decryptionTimestamps.filter(ts => ts >= oneMinuteAgo).length;
  return {
    total: decryptionCount,
    lastMinuteRate: recentCount,
  };
}
