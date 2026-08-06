/**
 * Circuit Breaker Pattern
 * Prevents cascading failures by fast-failing when the API is unhealthy
 *
 * States:
 *   CLOSED  → normal operation, requests pass through
 *   OPEN    → API is unhealthy, requests are immediately rejected
 *   HALF_OPEN → testing if API has recovered with a single probe request
 */

import { CircuitBreakerOpenError } from './errors.js';
import type { CircuitBreakerState, CircuitBreakerStatus } from './types.js';

export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenInProgress = false;

  constructor(
    private readonly threshold: number = 5,
    private readonly openTimeout: number = 30000
  ) {}

  /**
   * Execute a function through the circuit breaker.
   * - CLOSED: pass through, track failures
   * - OPEN: reject immediately (fast-fail) unless timeout elapsed → HALF_OPEN
   * - HALF_OPEN: allow one probe request
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      // Check if enough time has elapsed to try half-open
      if (Date.now() - this.lastFailureTime >= this.openTimeout) {
        this.state = 'HALF_OPEN';
        this.halfOpenInProgress = false;
      } else {
        throw new CircuitBreakerOpenError();
      }
    }

    if (this.state === 'HALF_OPEN' && this.halfOpenInProgress) {
      throw new CircuitBreakerOpenError(
        'Circuit breaker is half-open — probe request in progress'
      );
    }

    if (this.state === 'HALF_OPEN') {
      this.halfOpenInProgress = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Get current circuit breaker status
   */
  getStatus(): CircuitBreakerStatus {
    // Auto-transition from OPEN to HALF_OPEN if timeout elapsed
    if (
      this.state === 'OPEN' &&
      Date.now() - this.lastFailureTime >= this.openTimeout
    ) {
      this.state = 'HALF_OPEN';
      this.halfOpenInProgress = false;
    }

    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Manually reset the circuit breaker to CLOSED state
   */
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.halfOpenInProgress = false;
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      // Probe succeeded → close circuit
      this.state = 'CLOSED';
      this.halfOpenInProgress = false;
    }
    this.failureCount = 0;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      // Probe failed → re-open
      this.state = 'OPEN';
      this.halfOpenInProgress = false;
    } else if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
    }
  }
}
