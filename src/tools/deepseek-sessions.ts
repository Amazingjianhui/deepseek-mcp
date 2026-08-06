/**
 * Tool: deepseek_sessions
 * Session management for multi-turn conversations
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionStore } from '../session.js';
import { getErrorMessage } from '../types.js';

export function registerSessionsTool(server: McpServer, store: SessionStore): void {
  server.registerTool(
    'deepseek_sessions',
    {
      title: 'DeepSeek Session Management',
      description:
        'Manage multi-turn conversation sessions. List active sessions, delete a specific session, or clear all sessions. ' +
        'Sessions store conversation history for use with the session_id parameter in deepseek_chat.',
      inputSchema: {
        action: z
          .enum(['list', 'clear', 'delete'])
          .describe(
            'Action to perform. "list": show all active sessions, "clear": remove all sessions, "delete": remove a specific session (requires session_id)'
          ),
        session_id: z
          .string()
          .optional()
          .describe('Session ID to delete (required when action is "delete")'),
      },
    },
    async (input: { action: 'list' | 'clear' | 'delete'; session_id?: string }) => {
      try {

        switch (input.action) {
          case 'list': {
            const sessions = store.list();
            if (sessions.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'No active sessions.',
                  },
                ],
              };
            }

            let text = `**Active Sessions (${sessions.length}):**\n\n`;
            for (const s of sessions) {
              const created = new Date(s.createdAt).toISOString();
              const lastAccess = new Date(s.lastAccessedAt).toISOString();
              text += `- **${s.id}**\n`;
              text += `  Messages: ${s.messageCount} | Requests: ${s.requestCount} | Cost: $${s.totalCost.toFixed(4)}\n`;
              text += `  Created: ${created} | Last access: ${lastAccess}\n\n`;
            }

            return {
              content: [{ type: 'text' as const, text }],
            };
          }

          case 'delete': {
            if (!input.session_id) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: 'Error: session_id is required for delete action.',
                  },
                ],
                isError: true,
              };
            }

            const deleted = store.delete(input.session_id);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: deleted
                    ? `Session "${input.session_id}" deleted successfully.`
                    : `Session "${input.session_id}" not found.`,
                },
              ],
            };
          }

          case 'clear': {
            const count = store.clear();
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Cleared ${count} session(s).`,
                },
              ],
            };
          }
        }
      } catch (error: unknown) {
        console.error('[DeepSeek MCP] Session error:', error);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${getErrorMessage(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
