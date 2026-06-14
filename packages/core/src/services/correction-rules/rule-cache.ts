import { fetchRules } from './product-client.js';
import type { CorrectionRule, RuleCacheEntry } from './types.js';

const CACHE_TTL_MS = parseInt(process.env.CORRECTION_RULE_CACHE_TTL_MS || '60000', 10);

const cache = new Map<string, RuleCacheEntry>();
let disabledLogged = false;

export async function getRules(
  tenantId: string,
  assistantId: string,
): Promise<{ rules: CorrectionRule[]; snapshotVersion: string }> {
  if (!process.env.TWIN_PRODUCT_API_URL || !process.env.TWIN_PRODUCT_API_KEY) {
    if (!disabledLogged) {
      console.warn('[RuleCache] DAR disabled: TWIN_PRODUCT_API_URL/TWIN_PRODUCT_API_KEY not set');
      disabledLogged = true;
    }
    return { rules: [], snapshotVersion: 'disabled' };
  }

  const entry = cache.get(assistantId);
  const now = Date.now();

  if (entry && now - entry.fetchedAt < CACHE_TTL_MS) {
    return { rules: entry.rules, snapshotVersion: entry.snapshotVersion };
  }

  try {
    const result = await fetchRules(tenantId, assistantId, entry?.snapshotVersion);

    if (result === null) {
      if (entry) {
        return { rules: entry.rules, snapshotVersion: entry.snapshotVersion };
      }
      return { rules: [], snapshotVersion: 'empty' };
    }

    cache.set(assistantId, {
      rules: result.rules,
      snapshotVersion: result.snapshotVersion,
      fetchedAt: now,
    });

    return { rules: result.rules, snapshotVersion: result.snapshotVersion };
  } catch (err) {
    console.error({ err }, '[RuleCache] Pull failed');
    if (entry) {
      return { rules: entry.rules, snapshotVersion: entry.snapshotVersion };
    }
    return { rules: [], snapshotVersion: 'error' };
  }
}

export function invalidate(assistantId: string): void {
  cache.delete(assistantId);
}
