import { config } from '../config.js';
import { RateLimitedError } from './errors.js';

class ConcurrencyLimiter {
  private activeRequests = 0;

  public acquire(): void {
    if (this.activeRequests >= config.MAX_CONCURRENT_REQUESTS) {
      throw new RateLimitedError(
        `Max concurrent requests (${config.MAX_CONCURRENT_REQUESTS}) reached. Try again later.`
      );
    }
    this.activeRequests++;
  }

  public release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }
}

export const limiter = new ConcurrencyLimiter();
