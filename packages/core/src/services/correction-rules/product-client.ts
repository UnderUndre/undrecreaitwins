import { ssrfSafeFetch } from '../llm-provider/ssrf-audit.js';
import type { CorrectionRule } from './types.js';

const PRODUCT_API_URL = process.env.TWIN_PRODUCT_API_URL;
const PRODUCT_API_KEY = process.env.TWIN_PRODUCT_API_KEY;

export interface PullResult {
  rules: CorrectionRule[];
  snapshotVersion: string;
}

export async function fetchRules(
  tenantId: string,
  assistantId: string,
  knownSnapshotVersion?: string,
): Promise<PullResult | null> {
  if (!PRODUCT_API_URL || !PRODUCT_API_KEY) {
    return { rules: [], snapshotVersion: 'disabled' };
  }

  const url = `${PRODUCT_API_URL}/v1/correction-rules?assistantId=${encodeURIComponent(assistantId)}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${PRODUCT_API_KEY}`,
    'X-Tenant-ID': tenantId,
  };

  if (knownSnapshotVersion) {
    headers['If-None-Match'] = knownSnapshotVersion;
  }

  const response = await ssrfSafeFetch(url, {
    method: 'GET',
    headers,
    ssrfTimeoutMs: 5000,
  });

  if (response.status === 304) {
    return null;
  }

  if (response.status === 404) {
    return { rules: [], snapshotVersion: 'empty' };
  }

  if (!response.ok) {
    throw new Error(`Product API pull failed: ${response.status}`);
  }

  const body = await response.json() as { rules: CorrectionRule[]; snapshotVersion: string };
  return {
    rules: body.rules || [],
    snapshotVersion: body.snapshotVersion || 'unknown',
  };
}
