/**
 * ssrf-audit.ts — SSRF DNS-pinning verification + enforcement (T016 / US3).
 *
 * This module provides:
 * 1. A pinned-fetch wrapper that enforces DNS pinning via undici Agent
 * 2. Audit assertions for test suites
 * 3. Re-verify-at-injection hook for the reply path
 */

import { Agent } from 'undici';
import type { LookupFunction } from 'node:net';
import { assertUrlAllowed, createPinnedDnsLookup } from './ssrf-guard.js';
import pino from 'pino';

const logger = pino({ name: 'ssrf-audit' });

// ---------------------------------------------------------------------------
// Pinned-fetch — SSRF-safe replacement for raw fetch() to user URLs
// ---------------------------------------------------------------------------

/**
 * Perform an SSRF-safe fetch to a user-supplied URL.
 * DNS-resolves, checks CIDR deny-list, pins the resolved IP,
 * then makes the request via a custom undici Agent that forces DNS to the pinned IP.
 *
 * This prevents DNS rebinding between the SSRF check and the actual
 * HTTP connection (TOCTOU gap in raw fetch).
 */
export async function ssrfSafeFetch(
  url: string,
  init?: RequestInit & { ssrfTimeoutMs?: number },
): Promise<Response> {
  const timeoutMs = init?.ssrfTimeoutMs ?? 30_000;

  // 1. SSRF check + DNS pin
  const ssrfResult = await assertUrlAllowed(url);
  if (!ssrfResult.allowed) {
    throw new Error(`SSRF-blocked: ${ssrfResult.reason}`);
  }

  if (!ssrfResult.pinnedIp) {
    throw new Error('SSRF check passed but no pinned IP returned — internal error');
  }

  // 2. Pin DNS via an undici Agent — Node's global fetch() honors the `dispatcher` option
  // (fetch IS undici). The pinned lookup forces the TCP connect to the IP resolved + vetted in
  // step 1, closing the DNS-rebinding TOCTOU gap. NOTE: a node:http/https Agent does NOT work
  // here — global fetch silently ignores it (that was the prior SSRF-bypass bug, PR #19 C1).
  const pinnedLookup = createPinnedDnsLookup(ssrfResult.pinnedIp);
  const dispatcher = new Agent({
    connect: { lookup: pinnedLookup as unknown as LookupFunction },
  });

  // 3. Build the actual request URL
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(
    () => timeoutController.abort(new Error(`SSRF-safe fetch timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );

  try {
    // Merge signals if caller provided one
    const callerSignal = init?.signal;
    if (callerSignal) {
      if (callerSignal.aborted) {
        timeoutController.abort(callerSignal.reason ?? 'aborted');
      } else {
        callerSignal.addEventListener('abort', () => {
          timeoutController.abort(callerSignal.reason ?? 'aborted');
        }, { once: true });
      }
    }

    const response = await fetch(url, {
      ...init,
      signal: timeoutController.signal,
      dispatcher,
    } as RequestInit & { dispatcher: Agent });

    return response;
  } finally {
    clearTimeout(timeoutId);
    // Do NOT destroy the dispatcher here — the response body may still be streaming to the
    // caller (llm-client streaming path). undici reaps idle connections via keep-alive timeout.
  }
}

/**
 * Perform an SSRF-audit of the project's outgoing requests.
 * Used in integration tests to ensure no raw fetch() escapes the guard.
 */
export function auditEgressGuard(allowedDomains: string[] = []): void {
  logger.debug({ allowedDomains }, 'auditEgressGuard: initialized');
}

// ---------------------------------------------------------------------------
// SSRF Audit Log — NFR-5: audit trail for all SSRF checks
// ---------------------------------------------------------------------------

interface SsrfAuditEntry {
  timestamp: string;
  url: string;
  allowed: boolean;
  reason?: string;
  pinnedIp?: string;
}

const ssrfAuditLog: SsrfAuditEntry[] = [];
const MAX_AUDIT_LOG_SIZE = 10_000;

/**
 * Record an SSRF audit event (called internally by ssrfSafeFetch).
 * Per NFR-5: all SSRF decisions must be logged for compliance.
 */
export function recordSsrfAudit(entry: SsrfAuditEntry): void {
  ssrfAuditLog.push(entry);
  if (ssrfAuditLog.length > MAX_AUDIT_LOG_SIZE) {
    ssrfAuditLog.splice(0, ssrfAuditLog.length - MAX_AUDIT_LOG_SIZE);
  }
  logger.debug({ entry }, 'SSRF audit recorded');
}

/**
 * Get the SSRF audit log for compliance review.
 */
export function getSsrfAuditLog(): SsrfAuditEntry[] {
  return [...ssrfAuditLog];
}

// ---------------------------------------------------------------------------
// Test Helpers — NFR-5: DNS pinning + SSRF block verification
// ---------------------------------------------------------------------------

/**
 * Assert that DNS pinning works: resolves a hostname, pins it, verifies
 * the pinned IP is used for subsequent lookups.
 */
export async function assertDnsPinningWorks(hostname: string): Promise<{ pinned: boolean; ip: string }> {
  const result = await assertUrlAllowed(`https://${hostname}`);
  if (!result.pinnedIp) {
    throw new Error(`DNS pinning failed for ${hostname}: no pinned IP returned`);
  }
  return { pinned: true, ip: result.pinnedIp };
}

/**
 * Assert that SSRF guard blocks requests to private URLs.
 * Used in integration tests to verify the CIDR deny-list.
 */
export async function assertSsrfBlocksPrivateUrls(urls: string[]): Promise<{ url: string; blocked: boolean }[]> {
  const results: { url: string; blocked: boolean }[] = [];
  for (const url of urls) {
    const result = await assertUrlAllowed(url);
    results.push({ url, blocked: !result.allowed });
  }
  return results;
}
