/**
 * In-Memory Session Store
 * Manages multi-turn conversation sessions within a single MCP server instance lifetime.
 *
 * One SessionStore per McpServer instance. In HTTP transport mode this means
 * one store per connected HTTP session, which gives cross-client isolation.
 * In STDIO mode a single store is shared for the life of the process.
 */

import { randomUUID } from 'crypto';
import { getConfig } from './config.js';
import type { ChatMessage, Session, SessionInfo } from './types.js';

export class SessionStore {
  private sessions = new Map<string, Session>();
  private requestCounter = 0;

  /**
   * Create a new session or return existing one
   */
  create(sessionId?: string): Session {
    const id = sessionId || randomUUID();

    const existing = this.sessions.get(id);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    // Enforce max sessions limit
    const config = getConfig();
    if (this.sessions.size >= config.maxSessions) {
      this.cleanup();
      // If still at limit after cleanup, remove oldest session
      if (this.sessions.size >= config.maxSessions) {
        this.removeOldest();
      }
    }

    const session: Session = {
      id,
      messages: [],
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      totalCost: 0,
      requestCount: 0,
    };

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Get a session by ID, returns undefined if not found or expired
   */
  get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    // Check TTL
    if (this.isExpired(session)) {
      this.sessions.delete(sessionId);
      return undefined;
    }

    session.lastAccessedAt = Date.now();
    return session;
  }

  /**
   * Add messages to a session
   */
  addMessages(sessionId: string, messages: ChatMessage[]): void {
    const session = this.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.messages.push(...messages);

    // Enforce message limit (sliding window)
    const config = getConfig();
    if (session.messages.length > config.maxSessionMessages) {
      session.messages = session.messages.slice(-config.maxSessionMessages);
    }
  }

  /**
   * Get all messages from a session
   */
  getMessages(sessionId: string): ChatMessage[] {
    const session = this.get(sessionId);
    if (!session) return [];
    return [...session.messages];
  }

  /**
   * Delete a session
   */
  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * List all active (non-expired) sessions
   */
  list(): SessionInfo[] {
    this.lazyCleanup();
    const result: SessionInfo[] = [];
    for (const session of this.sessions.values()) {
      if (!this.isExpired(session)) {
        result.push({
          id: session.id,
          messageCount: session.messages.length,
          createdAt: session.createdAt,
          lastAccessedAt: session.lastAccessedAt,
          totalCost: session.totalCost,
          requestCount: session.requestCount,
        });
      }
    }
    return result;
  }

  /**
   * Clean up expired sessions, returns number of removed sessions
   */
  cleanup(): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (this.isExpired(session)) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get total cost across all sessions
   */
  getTotalCost(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      total += session.totalCost;
    }
    return total;
  }

  /**
   * Get active session count
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Clear all sessions
   */
  clear(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  /**
   * Lazy cleanup: runs full cleanup every 10 requests
   */
  private lazyCleanup(): void {
    this.requestCounter++;
    if (this.requestCounter % 10 === 0) {
      this.cleanup();
    }
  }

  private isExpired(session: Session): boolean {
    const config = getConfig();
    const ttlMs = config.sessionTtlMinutes * 60 * 1000;
    return Date.now() - session.lastAccessedAt > ttlMs;
  }

  private removeOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, session] of this.sessions) {
      if (session.lastAccessedAt < oldestTime) {
        oldestTime = session.lastAccessedAt;
        oldestId = id;
      }
    }
    if (oldestId) {
      this.sessions.delete(oldestId);
    }
  }
}
