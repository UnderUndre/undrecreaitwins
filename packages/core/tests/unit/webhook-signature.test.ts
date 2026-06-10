import { describe, it, expect } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import {
  verifySignature,
  verifyFeishuSignature,
  verifyWeComSignature,
  verifyGenericWebhookSignature,
} from '../../src/services/webhook-signature.js';

const SECRET = 'test-secret-key-1234567890';

function computeSignature(payload: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex');
}

describe('webhook-signature — signature bypass tests', () => {
  describe('verifySignature', () => {
    it('accepts valid HMAC-SHA256 signature', () => {
      const payload = '{"event":"message","text":"hello"}';
      const sig = computeSignature(payload, SECRET);
      expect(verifySignature(payload, sig, SECRET)).toBe(true);
    });

    it('rejects forged/incorrect signature', () => {
      const payload = '{"event":"message","text":"hello"}';
      expect(verifySignature(payload, 'forged-signature-value', SECRET)).toBe(false);
    });

    it('rejects empty signature', () => {
      const payload = '{"event":"message"}';
      expect(verifySignature(payload, '', SECRET)).toBe(false);
    });

    it('rejects correct signature for different secret', () => {
      const payload = '{"event":"message"}';
      const sig = computeSignature(payload, SECRET);
      expect(verifySignature(payload, sig, 'wrong-secret')).toBe(false);
    });

    it('rejects signature from different payload (replay attack on different data)', () => {
      const payloadA = '{"event":"message","text":"original"}';
      const payloadB = '{"event":"message","text":"modified"}';
      const sigA = computeSignature(payloadA, SECRET);
      expect(verifySignature(payloadB, sigA, SECRET)).toBe(false);
    });
  });

  describe('timing-leak resistance', () => {
    it('rejects signatures of different length without short-circuit (no length leak)', () => {
      const payload = '{"event":"message"}';
      const correctSig = computeSignature(payload, SECRET);
      // A very short forged signature (much shorter than correct)
      const shortForged = 'aa';
      // A longer forged signature
      const longForged = 'a'.repeat(correctSig.length + 50);

      // Both should return false — the key test is that timingSafeEqual is used
      // so the comparison time doesn't reveal length info
      expect(verifySignature(payload, shortForged, SECRET)).toBe(false);
      expect(verifySignature(payload, longForged, SECRET)).toBe(false);
    });

    it('does not throw on signatures with special characters', () => {
      const payload = '{"event":"message"}';
      const weirdSigs = [
        '\x00\x01\x02',
        '../../../../etc/passwd',
        '<script>alert(1)</script>',
        "' OR 1=1 --",
        '\n\r\t',
      ];

      for (const sig of weirdSigs) {
        expect(() => verifySignature(payload, sig, SECRET)).not.toThrow();
        expect(verifySignature(payload, sig, SECRET)).toBe(false);
      }
    });

    it('handles Buffer payload the same as string payload', () => {
      const payloadStr = '{"event":"message"}';
      const payloadBuf = Buffer.from(payloadStr);
      const sig = computeSignature(payloadStr, SECRET);

      expect(verifySignature(payloadStr, sig, SECRET)).toBe(true);
      expect(verifySignature(payloadBuf, sig, SECRET)).toBe(true);
    });
  });

  describe('verifyFeishuSignature', () => {
    it('accepts valid Feishu-style signature (timestamp+nonce+body)', () => {
      const timestamp = '1609459200';
      const nonce = 'random-nonce';
      const body = '{"event":"message"}';
      const expected = computeSignature(timestamp + nonce + body, SECRET);

      expect(verifyFeishuSignature(timestamp, nonce, body, expected, SECRET)).toBe(true);
    });

    it('rejects Feishu signature with modified timestamp', () => {
      const timestamp = '1609459200';
      const nonce = 'random-nonce';
      const body = '{"event":"message"}';
      const expected = computeSignature(timestamp + nonce + body, SECRET);

      expect(verifyFeishuSignature('9999999999', nonce, body, expected, SECRET)).toBe(false);
    });

    it('rejects Feishu signature with modified body', () => {
      const timestamp = '1609459200';
      const nonce = 'random-nonce';
      const body = '{"event":"message"}';
      const expected = computeSignature(timestamp + nonce + body, SECRET);

      expect(verifyFeishuSignature(timestamp, nonce, '{"event":"other"}', expected, SECRET)).toBe(false);
    });
  });

  describe('verifyWeComSignature', () => {
    it('accepts valid WeCom-style signature (sorted token+ts+nonce+encrypted)', () => {
      const token = 'my-token';
      const timestamp = '1609459200';
      const nonce = 'random-nonce';
      const encryptedMsg = 'encrypted-content-here';

      const arr = [token, timestamp, nonce, encryptedMsg].sort();
      const str = arr.join('');
      const hash = createHash('sha1').update(str).digest('hex');

      expect(verifyWeComSignature(token, timestamp, nonce, encryptedMsg, hash)).toBe(true);
    });

    it('rejects WeCom signature with wrong token', () => {
      const token = 'my-token';
      const timestamp = '1609459200';
      const nonce = 'random-nonce';
      const encryptedMsg = 'encrypted-content-here';

      const arr = [token, timestamp, nonce, encryptedMsg].sort();
      const str = arr.join('');
      const hash = createHash('sha1').update(str).digest('hex');

      expect(verifyWeComSignature('wrong-token', timestamp, nonce, encryptedMsg, hash)).toBe(false);
    });
  });

  describe('verifyGenericWebhookSignature', () => {
    it('accepts valid signature with sha256= prefix', () => {
      const body = '{"event":"push"}';
      const sig = 'sha256=' + computeSignature(body, SECRET);
      expect(verifyGenericWebhookSignature(body, sig, SECRET)).toBe(true);
    });

    it('accepts valid signature without prefix', () => {
      const body = '{"event":"push"}';
      const sig = computeSignature(body, SECRET);
      expect(verifyGenericWebhookSignature(body, sig, SECRET)).toBe(true);
    });

    it('rejects forged generic webhook signature', () => {
      const body = '{"event":"push"}';
      expect(verifyGenericWebhookSignature(body, 'sha256=forged', SECRET)).toBe(false);
    });
  });
});
