import { describe, it, expect } from 'vitest';
import { isRetryableProviderError } from '../../src/services/retry/provider-retry.worker.js';
import { AppError, ServiceUnavailableError } from '@undrecreaitwins/shared';

describe('Provider Retry Logic', () => {
  describe('isRetryableProviderError', () => {
    it('returns true for ServiceUnavailableError', () => {
      const err = new ServiceUnavailableError('LLM');
      expect(isRetryableProviderError(err)).toBe(true);
    });

    it('returns true for common retryable codes', () => {
      const err = new AppError('Connection reset', 500, 'ECONNRESET');
      expect(isRetryableProviderError(err)).toBe(true);
    });

    it('returns true for ACP process errors', () => {
      const err = new AppError('ACP exit', 500, 'acp_process_exit');
      expect(isRetryableProviderError(err)).toBe(true);
    });

    it('returns true for generic 5xx status codes', () => {
      const err = new AppError('Internal Error', 502, 'error');
      expect(isRetryableProviderError(err)).toBe(true);
    });

    it('returns false for 4xx status codes (except 429)', () => {
      const err = new AppError('Bad Request', 400, 'bad_request');
      expect(isRetryableProviderError(err)).toBe(false);
    });

    it('returns true for 429 Too Many Requests', () => {
      const err = new AppError('Rate limit', 429, 'rate_limit');
      expect(isRetryableProviderError(err)).toBe(true);
    });

    it('returns true for TimeoutError', () => {
      const err = new Error('Timeout');
      err.name = 'TimeoutError';
      expect(isRetryableProviderError(err)).toBe(true);
    });

    it('returns false for AbortError', () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      expect(isRetryableProviderError(err)).toBe(false);
    });
  });
});
