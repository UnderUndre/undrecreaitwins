/**
 * ssrf-guard.ts — SSRF egress guard for user-supplied base_url.
 *
 * - DNS-resolve-and-pin: resolve hostname, check CIDR, pin IP for connection
 * - Reject: loopback, RFC1918, link-local, cloud-metadata, CGN, IPv6 private
 * - Applied on config-save AND every reply-time call
 */

import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import pino from 'pino';

const logger = pino({ name: 'llm-provider-ssrf' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SsrfCheckResult {
  allowed: boolean;
  reason?: string;
  pinnedIp?: string;
  allIps?: string[];
}

// ---------------------------------------------------------------------------
// IPv4 CIDR deny list
// ---------------------------------------------------------------------------

interface Ipv4Cidr {
  network: number; // uint32 host-byte-order
  mask: number; // uint32 host-byte-order
  label: string;
}

function ipv4ToUint32(octets: [number, number, number, number]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function parseIpv4Cidr(cidr: string, label: string): Ipv4Cidr {
  const [ipPart, prefixLenStr] = cidr.split('/');
  if (ipPart === undefined || prefixLenStr === undefined) {
    throw new Error(`Invalid IPv4 CIDR: ${cidr}`);
  }
  const prefixLen = parseInt(prefixLenStr, 10);
  const octets = ipPart.split('.').map(Number) as [number, number, number, number];
  const network = ipv4ToUint32(octets);
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return { network: (network & mask) >>> 0, mask, label };
}

const IPV4_DENY: Ipv4Cidr[] = [
  parseIpv4Cidr('127.0.0.0/8', 'loopback'),
  parseIpv4Cidr('10.0.0.0/8', 'RFC1918-A'),
  parseIpv4Cidr('172.16.0.0/12', 'RFC1918-B'),
  parseIpv4Cidr('192.168.0.0/16', 'RFC1918-C'),
  parseIpv4Cidr('169.254.0.0/16', 'link-local'),
  parseIpv4Cidr('0.0.0.0/8', 'this-network'),
  parseIpv4Cidr('100.64.0.0/10', 'CGN'),
];

// ---------------------------------------------------------------------------
// IPv6 CIDR deny list
// ---------------------------------------------------------------------------

interface Ipv6Cidr {
  network: Uint8Array; // 16 bytes
  prefixLen: number;
  label: string;
}

function ipv6ToBytes(ip: string): Uint8Array {
  // Handle :: expansion
  const bytes = new Uint8Array(16);

  // IPv6-mapped IPv4 (::ffff:a.b.c.d)
  const mappedV4Match = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedV4Match && mappedV4Match[1]) {
    const v4Octets = mappedV4Match[1].split('.').map(Number);
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    bytes[12] = v4Octets[0] ?? 0;
    bytes[13] = v4Octets[1] ?? 0;
    bytes[14] = v4Octets[2] ?? 0;
    bytes[15] = v4Octets[3] ?? 0;
    return bytes;
  }

  // Expand :: shorthand
  let halves = ip.split('::');
  let left: string[];
  let right: string[];

  if (halves.length === 2) {
    left = halves[0] ? halves[0].split(':') : [];
    right = halves[1] ? halves[1].split(':') : [];
  } else {
    left = ip.split(':');
    right = [];
  }

  const missing = 8 - left.length - right.length;
  const expanded = [...left, ...Array(missing).fill('0'), ...right];

  for (let i = 0; i < 8; i++) {
    const val = parseInt(expanded[i] || '0', 16);
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }

  return bytes;
}

function parseIpv6Cidr(cidr: string, label: string): Ipv6Cidr {
  const [ipPart, prefixLenStr] = cidr.split('/');
  if (ipPart === undefined || prefixLenStr === undefined) {
    throw new Error(`Invalid IPv6 CIDR: ${cidr}`);
  }
  const prefixLen = parseInt(prefixLenStr, 10);
  const network = ipv6ToBytes(ipPart);
  // Mask the network bytes to the prefix length
  for (let i = prefixLen; i < 128; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    network[byteIdx] = (network[byteIdx] ?? 0) & ~(1 << bitIdx);
  }
  return { network, prefixLen, label };
}

const IPV6_DENY: Ipv6Cidr[] = [
  parseIpv6Cidr('::1/128', 'loopback'),
  parseIpv6Cidr('fe80::/10', 'link-local'),
  parseIpv6Cidr('fc00::/7', 'ULA'),
  parseIpv6Cidr('ff00::/8', 'multicast'),
  // IPv6-mapped IPv4 block ::ffff:0:0/96 — we check the embedded IPv4
  parseIpv6Cidr('::ffff:0.0.0.0/96', 'IPv4-mapped'),
];

// ---------------------------------------------------------------------------
// CIDR matching
// ---------------------------------------------------------------------------

function isIpv4InCidr(ip: string, cidr: Ipv4Cidr): boolean {
  const octets = ip.split('.').map(Number) as [number, number, number, number];
  const ipVal = ipv4ToUint32(octets);
  return ((ipVal & cidr.mask) >>> 0) === cidr.network;
}

function isIpv6InCidr(ipBytes: Uint8Array, cidr: Ipv6Cidr): boolean {
  for (let i = 0; i < 16; i++) {
    const prefixBitsRemaining = cidr.prefixLen - i * 8;
    if (prefixBitsRemaining <= 0) break;

    const mask = prefixBitsRemaining >= 8
      ? 0xff
      : (~0 << (8 - prefixBitsRemaining)) & 0xff;

    if (((ipBytes[i] ?? 0) & mask) !== ((cidr.network[i] ?? 0) & mask)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// isPrivateIp — public API
// ---------------------------------------------------------------------------

function parseIpv4String(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

export function isPrivateIp(ip: string): boolean {
  // Try IPv4 first
  const v4 = parseIpv4String(ip);
  if (v4) {
    return IPV4_DENY.some((cidr) => isIpv4InCidr(ip, cidr));
  }

  // Try IPv6 (including IPv6-mapped IPv4)
  let ipBytes: Uint8Array;
  try {
    ipBytes = ipv6ToBytes(ip);
  } catch {
    return false;
  }

  // Check against IPv6 deny list
  for (const cidr of IPV6_DENY) {
    if (isIpv6InCidr(ipBytes, cidr)) {
      // Special case: for ::ffff:0:0/96, also check the embedded IPv4
      if (cidr.label === 'IPv4-mapped') {
        const embeddedIpv4 = `${ipBytes[12]}.${ipBytes[13]}.${ipBytes[14]}.${ipBytes[15]}`;
        if (isPrivateIp(embeddedIpv4)) {
          return true;
        }
        // The IP is in the mapped range but the embedded IPv4 is public — allowed
        continue;
      }
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// assertUrlAllowed — main entry point
// ---------------------------------------------------------------------------

export async function assertUrlAllowed(url: string): Promise<SsrfCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${url}` };
  }

  if (parsed.protocol !== 'https:') {
    return { allowed: false, reason: `Only https: URLs are allowed, got ${parsed.protocol}` };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return { allowed: false, reason: 'URL has no hostname' };
  }

  // If hostname is already an IP address, skip DNS resolution
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      logger.warn({ hostname }, 'SSRF: provided IP is in private/reserved range');
      return {
        allowed: false,
        reason: `Provided IP ${hostname} is in a private/reserved range`,
        allIps: [hostname],
      };
    }
    return {
      allowed: true,
      pinnedIp: hostname,
      allIps: [hostname],
    };
  }

  // Resolve DNS (both A and AAAA)
  let allIps: string[] = [];
  try {
    const [v4Results, v6Results] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    if (v4Results.status === 'fulfilled') {
      allIps.push(...v4Results.value);
    }
    if (v6Results.status === 'fulfilled') {
      allIps.push(...v6Results.value);
    }
  } catch (err) {
    logger.warn({ hostname, err }, 'DNS resolution failed');
    return { allowed: false, reason: `DNS resolution failed for ${hostname}` };
  }

  if (allIps.length === 0) {
    return { allowed: false, reason: `No DNS records found for ${hostname}` };
  }

  // Check every IP against deny lists
  for (const ip of allIps) {
    if (isPrivateIp(ip)) {
      logger.warn({ hostname, ip }, 'SSRF: resolved to private/reserved IP');
      return {
        allowed: false,
        reason: `Resolved IP ${ip} for ${hostname} is in a private/reserved range`,
        allIps,
      };
    }
  }

  // Pin to first allowed IP
  const pinnedIp = allIps[0];
  logger.info({ hostname, pinnedIp, ipCount: allIps.length }, 'SSRF check passed');

  return {
    allowed: true,
    pinnedIp,
    allIps,
  };
}

// ---------------------------------------------------------------------------
// createPinnedDnsLookup — returns a dns.lookup-compatible function that
// always resolves to the pinned IP, preventing DNS rebinding attacks.
// ---------------------------------------------------------------------------

export function createPinnedDnsLookup(
  pinnedIp: string,
): (hostname: string, options: any, cb: (err: Error | null, address: string, family: number) => void) => void {
  const isV6 = pinnedIp.includes(':');
  const family = isV6 ? 6 : 4;

  return (_hostname: string, _options: any, cb: (err: Error | null, address: string, family: number) => void) => {
    process.nextTick(() => cb(null, pinnedIp, family));
  };
}
