/**
 * test-connection — validate provider config by calling the upstream.
 *
 * - Typed ok/reason response
 * - Rate-limited per-tenant (enforced at API layer)
 * - Never leaks key or raw upstream body
 */

import { assertUrlAllowed, createPinnedDnsLookup } from './ssrf-guard.js';
import https from 'node:https';
import http from 'node:http';

export interface TestConnectionResult {
  ok: boolean;
  reason?: 'AUTH' | 'TIMEOUT' | 'MODEL_NOT_FOUND' | 'UNREACHABLE' | 'SSRF_BLOCKED';
}

/**
 * Validate a provider connection by calling its /v1/models endpoint.
 */
export async function testProviderConnection(
  baseUrl: string,
  modelId: string,
  apiKey: string,
): Promise<TestConnectionResult> {
  // 1. SSRF check + pin
  const ssrf = await assertUrlAllowed(baseUrl);
  if (!ssrf.allowed || !ssrf.pinnedIp) {
    return { ok: false, reason: 'SSRF_BLOCKED' };
  }

  return new Promise((resolve) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(`${baseUrl}/v1/models`);
    } catch {
      resolve({ ok: false, reason: 'UNREACHABLE' });
      return;
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const lookup = createPinnedDnsLookup(ssrf.pinnedIp!);
    const agent = isHttps
      ? new https.Agent({ lookup })
      : new http.Agent({ lookup });

    const options = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      agent,
      timeout: 10000,
    };

    const req = (isHttps ? https : http).request(parsedUrl, options, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        resolve({ ok: false, reason: 'AUTH' });
        return;
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        resolve({ ok: false, reason: 'UNREACHABLE' });
        return;
      }

      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body) as { data?: Array<{ id: string }> };
          const models = data.data || [];
          const found = models.some((m) => m.id === modelId);

          if (!found && modelId !== 'default' && modelId !== '*') {
            resolve({ ok: false, reason: 'MODEL_NOT_FOUND' });
          } else {
            resolve({ ok: true });
          }
        } catch {
          resolve({ ok: false, reason: 'UNREACHABLE' });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'TIMEOUT' });
    });

    req.on('error', (err: any) => {
      if (err.code === 'ECONNRESET' || err.message?.includes('timeout')) {
        resolve({ ok: false, reason: 'TIMEOUT' });
      } else {
        resolve({ ok: false, reason: 'UNREACHABLE' });
      }
    });

    req.end();
  });
}
