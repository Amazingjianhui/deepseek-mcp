import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, resetConfig } from '../config.js';
import { SessionStore } from '../session.js';
import { registerSessionsTool } from './deepseek-sessions.js';

function createMockServer() {
  const tools = new Map<string, { meta: unknown; handler: Function }>();
  return {
    registerTool: vi.fn(
      (name: string, meta: unknown, handler: Function) => {
        tools.set(name, { meta, handler });
      }
    ),
    tools,
  };
}

describe('deepseek_sessions tool', () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let handler: Function;
  let store: SessionStore;

  beforeEach(() => {
    resetConfig();
    process.env.DEEPSEEK_API_KEY = 'sk-test1234567890abcdef';
    loadConfig();
    store = new SessionStore();
    mockServer = createMockServer();
    registerSessionsTool(mockServer as any, store);
    handler = mockServer.tools.get('deepseek_sessions')!.handler;
  });

  afterEach(() => {
    resetConfig();
  });

  it('should register with correct name', () => {
    expect(mockServer.registerTool).toHaveBeenCalledTimes(1);
    expect(mockServer.tools.has('deepseek_sessions')).toBe(true);
  });

  describe('list action', () => {
    it('should return "No active sessions" when store is empty', async () => {
      const result = await handler({ action: 'list' });
      expect(result.content[0].text).toBe('No active sessions.');
    });

    it('should list sessions with details', async () => {
      store.create('session-a');
      store.addMessages('session-a', [{ role: 'user', content: 'hello' }]);
      store.create('session-b');

      const result = await handler({ action: 'list' });
      const text = result.content[0].text;
      expect(text).toContain('Active Sessions (2)');
      expect(text).toContain('session-a');
      expect(text).toContain('session-b');
      expect(text).toContain('Messages: 1');
    });

    it('should only see sessions from its own store', async () => {
      // Another store (simulating another HTTP session) has its own data
      const otherStore = new SessionStore();
      otherStore.create('other-session-x');
      otherStore.addMessages('other-session-x', [
        { role: 'user', content: 'SECRET from another client' },
      ]);

      const result = await handler({ action: 'list' });
      expect(result.content[0].text).toBe('No active sessions.');
    });
  });

  describe('delete action', () => {
    it('should return error when session_id is missing', async () => {
      const result = await handler({ action: 'delete' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('session_id is required');
    });

    it('should delete existing session', async () => {
      store.create('to-delete');

      const result = await handler({ action: 'delete', session_id: 'to-delete' });
      expect(result.content[0].text).toContain('deleted successfully');
      expect(store.get('to-delete')).toBeUndefined();
    });

    it('should report when session not found', async () => {
      const result = await handler({ action: 'delete', session_id: 'nonexistent' });
      expect(result.content[0].text).toContain('not found');
    });

    it('should not delete sessions from another store', async () => {
      const otherStore = new SessionStore();
      otherStore.create('victim-session');

      const result = await handler({ action: 'delete', session_id: 'victim-session' });
      expect(result.content[0].text).toContain('not found');
      // Other store must still have it
      expect(otherStore.get('victim-session')).toBeDefined();
    });
  });

  describe('clear action', () => {
    it('should clear 0 sessions when empty', async () => {
      const result = await handler({ action: 'clear' });
      expect(result.content[0].text).toBe('Cleared 0 session(s).');
    });

    it('should clear all sessions', async () => {
      store.create('s1');
      store.create('s2');
      store.create('s3');

      const result = await handler({ action: 'clear' });
      expect(result.content[0].text).toBe('Cleared 3 session(s).');
      expect(store.list()).toHaveLength(0);
    });

    it('should not clear sessions from another store', async () => {
      store.create('my-session');
      const otherStore = new SessionStore();
      otherStore.create('their-session-a');
      otherStore.create('their-session-b');

      await handler({ action: 'clear' });
      expect(store.size).toBe(0);
      expect(otherStore.size).toBe(2);
    });
  });
});
