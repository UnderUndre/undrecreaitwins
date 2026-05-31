import { describe, it, expect, vi } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';

describe('Protocol & Rate Limiting', () => {
  it('should retry on short FloodWait (<= 60s)', async () => {
    const limiter = new RateLimiter();
    let calls = 0;
    
    const operation = async () => {
      calls++;
      if (calls === 1) {
        const err: any = new Error('FloodWait');
        err.name = 'FloodWaitError';
        err.seconds = 1;
        throw err;
      }
      return 'success';
    };

    vi.useFakeTimers();
    const promise = limiter.executeWithRetry('peer1', operation);
    
    await vi.runAllTimersAsync();
    const result = await promise;
    
    expect(result).toBe('success');
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('should drop on long FloodWait (> 60s)', async () => {
    const limiter = new RateLimiter();
    const operation = async () => {
      const err: any = new Error('FloodWait');
      err.name = 'FloodWaitError';
      err.seconds = 61;
      throw err;
    };

    try {
      await limiter.executeWithRetry('peer2', operation);
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.name).toBe('FloodWaitError');
      expect(err.seconds).toBe(61);
    }
  });
});
