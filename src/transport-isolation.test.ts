/**
 * Cross-session isolation test for HTTP transport.
 *
 * Guards against the vulnerability fixed in 1.7.0 where SessionStore was a
 * process-wide singleton, allowing any HTTP client to read, list, delete, or
 * clear another HTTP client's conversation history via a shared session_id.
 *
 * The fix: each HTTP session's serverFactory call builds its own SessionStore
 * and closes over it in the registered tool handlers. This test proves that.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { createHttpApp } from './transport-http.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SessionStore } from './session.js';
import { loadConfig, resetConfig } from './config.js';
import { registerSessionsTool } from './tools/deepseek-sessions.js';

describe('HTTP transport — per-session SessionStore isolation', () => {
  let server: Server;
  let baseUrl: string;
  let capturedStores: SessionStore[] = [];

  beforeEach(async () => {
    resetConfig();
    process.env.DEEPSEEK_API_KEY = 'sk-test1234567890abcdef';
    loadConfig();
    capturedStores = [];

    // Factory mirrors src/index.ts HTTP path: fresh server AND fresh store
    // per invocation, registered together so the tool handler closes over
    // the per-session store.
    const factory = () => {
      const mcpServer = new McpServer({ name: 'iso-test', version: '0.0.0' });
      const store = new SessionStore();
      capturedStores.push(store);
      registerSessionsTool(mcpServer, store);
      return mcpServer;
    };

    const app = createHttpApp(factory);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    resetConfig();
    vi.restoreAllMocks();
  });

  async function initSession(clientName: string): Promise<string> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: clientName, version: '1.0' },
        },
        id: 1,
      }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (!sid) throw new Error('no session id');
    return sid;
  }

  it('creates a fresh SessionStore for each new HTTP session', async () => {
    await initSession('client-a');
    await initSession('client-b');

    expect(capturedStores).toHaveLength(2);
    expect(capturedStores[0]).not.toBe(capturedStores[1]);
  });

  it('does not let one HTTP session observe another session store state', async () => {
    await initSession('client-a');
    await initSession('client-b');

    const [storeA, storeB] = capturedStores;

    // Client A seeds its own store with sensitive data
    storeA.create('private-session-xyz');
    storeA.addMessages('private-session-xyz', [
      { role: 'user', content: 'this is Alice secret conversation' },
    ]);

    // Client B must not be able to read, see, or affect it via its store
    expect(storeB.get('private-session-xyz')).toBeUndefined();
    expect(storeB.getMessages('private-session-xyz')).toEqual([]);
    expect(storeB.list()).toHaveLength(0);
    expect(storeB.size).toBe(0);

    // Client B "clear" must not nuke Client A's data
    storeB.clear();
    expect(storeA.get('private-session-xyz')).toBeDefined();
    expect(storeA.getMessages('private-session-xyz')).toHaveLength(1);
  });

  it('stores do not share state even when user-supplied session_id collides', async () => {
    await initSession('client-a');
    await initSession('client-b');

    const [storeA, storeB] = capturedStores;

    // Both clients happen to use the same user-supplied session_id.
    // Pre-fix this would merge into one shared record in the singleton.
    // Post-fix the two stores are independent.
    storeA.create('shared-id');
    storeA.addMessages('shared-id', [
      { role: 'user', content: 'Alice message' },
    ]);

    storeB.create('shared-id');
    storeB.addMessages('shared-id', [
      { role: 'user', content: 'Bob message' },
    ]);

    const aMessages = storeA.getMessages('shared-id');
    const bMessages = storeB.getMessages('shared-id');
    expect(aMessages).toHaveLength(1);
    expect(bMessages).toHaveLength(1);
    expect(aMessages[0].content).toBe('Alice message');
    expect(bMessages[0].content).toBe('Bob message');
  });
});
