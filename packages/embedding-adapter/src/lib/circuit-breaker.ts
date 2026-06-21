import { config } from '../config.js';
import { CircuitOpenError } from './errors.js';

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private nextAttemptTime = 0;

  public checkCall(): void {
    const now = Date.now();

    if (this.state === 'OPEN') {
      if (now >= this.nextAttemptTime) {
        this.state = 'HALF_OPEN';
      } else {
        const remainingSeconds = Math.ceil((this.nextAttemptTime - now) / 1000);
        throw new CircuitOpenError(
          `Circuit breaker is open: ${config.CIRCUIT_FAILURE_THRESHOLD} consecutive failures. Try again in ${remainingSeconds}s`
        );
      }
    }
  }

  public recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.failureCount = 0;
    }
  }

  public recordFailure(): void {
    this.failureCount++;
    if (this.state === 'HALF_OPEN' || this.failureCount >= config.CIRCUIT_FAILURE_THRESHOLD) {
      this.state = 'OPEN';
      this.nextAttemptTime = Date.now() + config.CIRCUIT_RESET_TIMEOUT * 1000;
    }
  }
}

// Map of circuit breakers per provider
const breakers = new Map<string, CircuitBreaker>();

export function getBreaker(provider: string): CircuitBreaker {
  let breaker = breakers.get(provider);
  if (!breaker) {
    breaker = new CircuitBreaker();
    breakers.set(provider, breaker);
  }
  return breaker;
}

export function resetBreakers(): void {
  breakers.clear();
}
