import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, resetConfig } from './config.js';
import { SessionStore } from './session.js';

describe('SessionStore', () => {
  beforeEach(() => {
    resetConfig();
    process.env.DEEPSEEK_API_KEY = 'test-key';
    process.env.SESSION_TTL_MINUTES = '30';
    process.env.MAX_SESSIONS = '5';
    loadConfig();
  });

  afterEach(() => {
    resetConfig();
    delete process.env.SESSION_TTL_MINUTES;
    delete process.env.MAX_SESSIONS;
    vi.restoreAllMocks();
  });

  describe('instantiation', () => {
    it('should produce independent instances', () => {
      const a = new SessionStore();
      const b = new SessionStore();
      expect(a).not.toBe(b);
      a.create('only-in-a');
      expect(a.size).toBe(1);
      expect(b.size).toBe(0);
    });
  });

  describe('create', () => {
    it('should create a session with given id', () => {
      const store = new SessionStore();
      const session = store.create('test-1');
      expect(session.id).toBe('test-1');
      expect(session.messages).toEqual([]);
      expect(session.requestCount).toBe(0);
      expect(session.totalCost).toBe(0);
    });

    it('should create a session with auto-generated id', () => {
      const store = new SessionStore();
      const session = store.create();
      expect(session.id).toBeTruthy();
      expect(session.id.length).toBeGreaterThan(0);
    });

    it('should return existing session if id exists', () => {
      const store = new SessionStore();
      const s1 = store.create('test-1');
      s1.requestCount = 5;
      const s2 = store.create('test-1');
      expect(s2.requestCount).toBe(5);
    });

    it('should enforce max sessions limit', () => {
      const store = new SessionStore();
      for (let i = 0; i < 5; i++) {
        store.create(`session-${i}`);
      }
      expect(store.size).toBe(5);
      // Creating 6th should evict oldest
      store.create('session-new');
      expect(store.size).toBe(5);
    });
  });

  describe('get', () => {
    it('should return session by id', () => {
      const store = new SessionStore();
      store.create('test-1');
      const session = store.get('test-1');
      expect(session).toBeDefined();
      expect(session!.id).toBe('test-1');
    });

    it('should return undefined for non-existent session', () => {
      const store = new SessionStore();
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('should return undefined for expired session', () => {
      const store = new SessionStore();
      const session = store.create('test-1');
      // Simulate expiry: set lastAccessedAt to 31 minutes ago
      session.lastAccessedAt = Date.now() - 31 * 60 * 1000;
      expect(store.get('test-1')).toBeUndefined();
    });

    it('should update lastAccessedAt on get', () => {
      const store = new SessionStore();
      store.create('test-1');
      const before = Date.now();
      const session = store.get('test-1');
      expect(session!.lastAccessedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('addMessages', () => {
    it('should add messages to session', () => {
      const store = new SessionStore();
      store.create('test-1');
      store.addMessages('test-1', [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      ]);
      expect(store.getMessages('test-1')).toHaveLength(2);
    });

    it('should throw for non-existent session', () => {
      const store = new SessionStore();
      expect(() =>
        store.addMessages('nonexistent', [{ role: 'user', content: 'Hi' }])
      ).toThrow('Session not found');
    });
  });

  describe('getMessages', () => {
    it('should return empty array for non-existent session', () => {
      const store = new SessionStore();
      expect(store.getMessages('nonexistent')).toEqual([]);
    });

    it('should return a copy of messages', () => {
      const store = new SessionStore();
      store.create('test-1');
      store.addMessages('test-1', [{ role: 'user', content: 'Hi' }]);
      const messages = store.getMessages('test-1');
      messages.push({ role: 'assistant', content: 'extra' });
      // Original should be unaffected
      expect(store.getMessages('test-1')).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('should delete existing session', () => {
      const store = new SessionStore();
      store.create('test-1');
      expect(store.delete('test-1')).toBe(true);
      expect(store.get('test-1')).toBeUndefined();
    });

    it('should return false for non-existent session', () => {
      const store = new SessionStore();
      expect(store.delete('nonexistent')).toBe(false);
    });
  });

  describe('list', () => {
    it('should list all active sessions', () => {
      const store = new SessionStore();
      store.create('s1');
      store.create('s2');
      const list = store.list();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    });

    it('should exclude expired sessions', () => {
      const store = new SessionStore();
      const s1 = store.create('s1');
      store.create('s2');
      s1.lastAccessedAt = Date.now() - 31 * 60 * 1000;
      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('s2');
    });

    it('should return session info without messages', () => {
      const store = new SessionStore();
      store.create('s1');
      store.addMessages('s1', [{ role: 'user', content: 'Hi' }]);
      const list = store.list();
      expect(list[0].messageCount).toBe(1);
      expect((list[0] as any).messages).toBeUndefined();
    });
  });

  describe('cleanup', () => {
    it('should remove expired sessions', () => {
      const store = new SessionStore();
      const s1 = store.create('s1');
      store.create('s2');
      s1.lastAccessedAt = Date.now() - 31 * 60 * 1000;
      const removed = store.cleanup();
      expect(removed).toBe(1);
      expect(store.size).toBe(1);
    });

    it('should return 0 when no sessions expired', () => {
      const store = new SessionStore();
      store.create('s1');
      expect(store.cleanup()).toBe(0);
    });
  });

  describe('clear', () => {
    it('should remove all sessions', () => {
      const store = new SessionStore();
      store.create('s1');
      store.create('s2');
      const count = store.clear();
      expect(count).toBe(2);
      expect(store.size).toBe(0);
    });
  });

  describe('getTotalCost', () => {
    it('should sum costs across all sessions', () => {
      const store = new SessionStore();
      const s1 = store.create('s1');
      const s2 = store.create('s2');
      s1.totalCost = 0.05;
      s2.totalCost = 0.10;
      expect(store.getTotalCost()).toBeCloseTo(0.15);
    });
  });

  describe('isolation between instances', () => {
    it('should not share state across separate stores', () => {
      const a = new SessionStore();
      const b = new SessionStore();
      a.create('shared-id');
      a.addMessages('shared-id', [{ role: 'user', content: 'secret' }]);
      // Another store with the same id must see nothing
      expect(b.get('shared-id')).toBeUndefined();
      expect(b.getMessages('shared-id')).toEqual([]);
      expect(b.size).toBe(0);
    });

    it('should not be affected by other store clears', () => {
      const a = new SessionStore();
      const b = new SessionStore();
      a.create('a1');
      b.create('b1');
      b.clear();
      expect(a.size).toBe(1);
      expect(a.get('a1')).toBeDefined();
    });
  });
});
