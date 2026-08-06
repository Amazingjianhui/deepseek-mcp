import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';
import { CircuitBreakerOpenError } from './errors.js';

describe('CircuitBreaker', () => {
  describe('CLOSED state', () => {
    it('should pass through successful calls', async () => {
      const cb = new CircuitBreaker(3, 1000);
      const result = await cb.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
      expect(cb.getStatus().state).toBe('CLOSED');
    });

    it('should track failures without opening below threshold', async () => {
      const cb = new CircuitBreaker(3, 1000);
      for (let i = 0; i < 2; i++) {
        await expect(
          cb.execute(() => Promise.reject(new Error('fail')))
        ).rejects.toThrow('fail');
      }
      expect(cb.getStatus().state).toBe('CLOSED');
      expect(cb.getStatus().failureCount).toBe(2);
    });

    it('should open after reaching failure threshold', async () => {
      const cb = new CircuitBreaker(3, 1000);
      for (let i = 0; i < 3; i++) {
        await expect(
          cb.execute(() => Promise.reject(new Error('fail')))
        ).rejects.toThrow('fail');
      }
      expect(cb.getStatus().state).toBe('OPEN');
    });

    it('should reset failure count on success', async () => {
      const cb = new CircuitBreaker(3, 1000);
      // 2 failures
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(cb.getStatus().failureCount).toBe(2);
      // 1 success resets
      await cb.execute(() => Promise.resolve('ok'));
      expect(cb.getStatus().failureCount).toBe(0);
    });
  });

  describe('OPEN state', () => {
    it('should reject immediately when open', async () => {
      const cb = new CircuitBreaker(1, 60000);
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(cb.getStatus().state).toBe('OPEN');
      await expect(
        cb.execute(() => Promise.resolve('should not run'))
      ).rejects.toThrow(CircuitBreakerOpenError);
    });

    it('should transition to HALF_OPEN after timeout', async () => {
      const cb = new CircuitBreaker(1, 100);
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(cb.getStatus().state).toBe('OPEN');

      // Wait for timeout
      await new Promise((r) => setTimeout(r, 150));
      expect(cb.getStatus().state).toBe('HALF_OPEN');
    });
  });

  describe('HALF_OPEN state', () => {
    it('should close on successful probe', async () => {
      const cb = new CircuitBreaker(1, 100);
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      await new Promise((r) => setTimeout(r, 150));
      // Probe succeeds
      const result = await cb.execute(() => Promise.resolve('recovered'));
      expect(result).toBe('recovered');
      expect(cb.getStatus().state).toBe('CLOSED');
      expect(cb.getStatus().failureCount).toBe(0);
    });

    it('should re-open on failed probe', async () => {
      const cb = new CircuitBreaker(1, 100);
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();

      await new Promise((r) => setTimeout(r, 150));
      // Probe fails
      await expect(
        cb.execute(() => Promise.reject(new Error('still failing')))
      ).rejects.toThrow('still failing');
      expect(cb.getStatus().state).toBe('OPEN');
    });
  });

  describe('reset', () => {
    it('should reset to CLOSED state', async () => {
      const cb = new CircuitBreaker(1, 60000);
      await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow();
      expect(cb.getStatus().state).toBe('OPEN');

      cb.reset();
      expect(cb.getStatus().state).toBe('CLOSED');
      expect(cb.getStatus().failureCount).toBe(0);
    });
  });

  describe('execute passthrough', () => {
    it('should propagate the original error', async () => {
      const cb = new CircuitBreaker(5, 1000);
      const customError = new Error('custom API error');
      await expect(cb.execute(() => Promise.reject(customError))).rejects.toThrow(
        'custom API error'
      );
    });

    it('should return the value from the function', async () => {
      const cb = new CircuitBreaker();
      const result = await cb.execute(() => Promise.resolve({ data: 42 }));
      expect(result).toEqual({ data: 42 });
    });
  });
});
