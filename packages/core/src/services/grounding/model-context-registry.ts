import pino from 'pino';

const logger = pino({ name: 'model-context-registry' });

/**
 * Known model context windows (in tokens).
 * Source: provider documentation.
 * Unknown models default to a conservative 8K assumption with a warning.
 */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-sonnet-4-20250514': 200_000,
  'claude-3-haiku-20240307': 200_000,
};

/** Minimum context window for big-context mode (32K tokens). */
const BIG_CONTEXT_MINIMUM = 32_000;

/** Track already-warned personas to avoid log spam on every request. */
const warnedPersonas = new Set<string>();

/**
 * Get known context window for a model name.
 * Returns `null` for completely unknown models.
 */
export function getModelContextWindow(modelName: string): number | null {
  return KNOWN_CONTEXT_WINDOWS[modelName] ?? null;
}

/**
 * Validate that a model's context window is adequate for big-context mode.
 * Logs a warning once per persona when:
 *   - The model is unknown (conservatively assume < 32K)
 *   - The model's known window is below 32K
 */
export function warnIfModelWindowInadequate(
  modelName: string | undefined | null,
  personaId: string,
  tenantId: string,
): void {
  if (!modelName) return;

  const key = `${tenantId}:${personaId}`;
  if (warnedPersonas.has(key)) return;

  const contextWindow = getModelContextWindow(modelName);

  if (contextWindow === null) {
    logger.warn({
      model: modelName,
      personaId,
      tenantId,
    }, 'Big-context mode enabled for model with unknown context window — assuming < 32K, quality may degrade');
    warnedPersonas.add(key);
    return;
  }

  if (contextWindow < BIG_CONTEXT_MINIMUM) {
    logger.warn({
      model: modelName,
      contextWindow,
      personaId,
      tenantId,
    }, `Big-context mode enabled but model context window (${contextWindow}) is below 32K threshold — quality may degrade`);
    warnedPersonas.add(key);
  }
}

/**
 * Reset warned-persona tracking (for tests).
 */
export function __resetWarnedPersonasForTests(): void {
  warnedPersonas.clear();
}
