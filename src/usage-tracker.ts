/**
 * Usage Tracker
 * Singleton that tracks aggregated API usage statistics
 */

import type { UsageStats } from './types.js';

export class UsageTracker {
  private static instance: UsageTracker | null = null;

  private totalRequests = 0;
  private totalTokens = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalCost = 0;
  private cacheHitTokens = 0;
  private cacheMissTokens = 0;
  private sessionSource: (() => number) | null = null;

  private constructor() {}

  static getInstance(): UsageTracker {
    if (!UsageTracker.instance) {
      UsageTracker.instance = new UsageTracker();
    }
    return UsageTracker.instance;
  }

  /**
   * Reset singleton (for testing)
   */
  static resetInstance(): void {
    UsageTracker.instance = null;
  }

  /**
   * Wire up a callback that reports the current active session count.
   * In STDIO mode this maps to the single shared SessionStore.
   * In HTTP mode no source is set — each HTTP session owns its own store,
   * so a process-wide count would be misleading and could leak tenant info.
   */
  setSessionSource(fn: () => number): void {
    this.sessionSource = fn;
  }

  /**
   * Clear the session source (used in tests or when swapping stores)
   */
  clearSessionSource(): void {
    this.sessionSource = null;
  }

  /**
   * Track a completed API request
   */
  trackRequest(
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
    },
    cost: number
  ): void {
    this.totalRequests++;
    this.totalTokens += usage.total_tokens;
    this.totalPromptTokens += usage.prompt_tokens;
    this.totalCompletionTokens += usage.completion_tokens;
    this.totalCost += cost;

    if (usage.prompt_cache_hit_tokens !== undefined) {
      this.cacheHitTokens += usage.prompt_cache_hit_tokens;
    }
    if (usage.prompt_cache_miss_tokens !== undefined) {
      this.cacheMissTokens += usage.prompt_cache_miss_tokens;
    }
  }

  /**
   * Get current usage statistics
   */
  getStats(): UsageStats {
    let activeSessions = 0;
    if (this.sessionSource) {
      try {
        activeSessions = this.sessionSource();
      } catch {
        // callback failed — fall through with 0
      }
    }

    return {
      totalRequests: this.totalRequests,
      totalTokens: this.totalTokens,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalCost: this.totalCost,
      cacheHitTokens: this.cacheHitTokens,
      cacheMissTokens: this.cacheMissTokens,
      activeSessions,
    };
  }

  /**
   * Get cache hit ratio (0-1)
   */
  getCacheHitRatio(): number {
    const total = this.cacheHitTokens + this.cacheMissTokens;
    if (total === 0) return 0;
    return this.cacheHitTokens / total;
  }
}
