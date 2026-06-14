import { ssrfSafeFetch } from '../llm-provider/ssrf-audit.js';
import type { QualityEventPush } from './types.js';

const PRODUCT_API_URL = process.env.TWIN_PRODUCT_API_URL;
const PRODUCT_API_KEY = process.env.TWIN_PRODUCT_API_KEY;
let noOpLogged = false;

export function pushEvents(
  tenantId: string,
  events: QualityEventPush[],
): void {
  if (!PRODUCT_API_URL || !PRODUCT_API_KEY || events.length === 0) {
    if (!PRODUCT_API_URL && !noOpLogged) {
      console.warn('[EventPush] No-op: TWIN_PRODUCT_API_URL not set');
      noOpLogged = true;
    }
    return;
  }

  const url = `${PRODUCT_API_URL}/v1/quality-events`;

  ssrfSafeFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PRODUCT_API_KEY}`,
      'X-Tenant-ID': tenantId,
    },
    body: JSON.stringify({ events }),
    ssrfTimeoutMs: 5000,
  }).catch(err => {
    console.error({ err }, '[EventPush] Push failed (fire-and-forget)');
  });
}
