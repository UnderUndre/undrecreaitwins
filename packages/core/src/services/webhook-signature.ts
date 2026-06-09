import { createHmac, timingSafeEqual } from 'node:crypto';
import pino from 'pino';

const logger = pino({ name: 'webhook-signature' });

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    const maxLen = Math.max(bufA.length, bufB.length);
    const paddedA = Buffer.alloc(maxLen);
    const paddedB = Buffer.alloc(maxLen);
    bufA.copy(paddedA);
    bufB.copy(paddedB);
    return timingSafeEqual(paddedA, paddedB);
  }

  return timingSafeEqual(bufA, bufB);
}

export function verifySignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
  algorithm: 'sha256' = 'sha256',
): boolean {
  const hmac = createHmac(algorithm, secret);
  hmac.update(payload);
  const expected = hmac.digest('hex');

  const match = safeCompare(expected, signature);

  if (!match) {
    logger.warn(
      {
        algorithm,
        payloadLength: typeof payload === 'string' ? payload.length : payload.length,
        signaturePrefix: signature.slice(0, 8) + '...',
      },
      'Signature verification failed',
    );
  }

  return match;
}

export function verifyFeishuSignature(
  timestamp: string,
  nonce: string,
  body: string,
  signature: string,
  secret: string,
): boolean {
  const payload = timestamp + nonce + body;
  return verifySignature(payload, signature, secret);
}

export function verifyWeComSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  return verifySignature(body, signature, secret);
}

export function verifyGenericWebhookSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const cleanSignature = signature.startsWith('sha256=')
    ? signature.slice(7)
    : signature;
  return verifySignature(body, cleanSignature, secret);
}
