/**
 * Resource: deepseek://config
 * Static resource showing current server configuration (API key masked)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getConfig } from '../config.js';

/**
 * Mask an API key for safe display: sk-****1234
 */
function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 3) + '****' + key.slice(-4);
}

export function registerConfigResource(server: McpServer): void {
  server.registerResource(
    'config',
    'deepseek://config',
    {
      title: 'DeepSeek Configuration',
      description:
        'Current server configuration including base URL, timeouts, session settings, and fallback status. API key is masked for security.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const config = getConfig();
      const safeConfig = {
        apiKey: maskApiKey(config.apiKey),
        baseUrl: config.baseUrl,
        requestTimeout: config.requestTimeout,
        maxRetries: config.maxRetries,
        showCostInfo: config.showCostInfo,
        maxMessageLength: config.maxMessageLength,
        sessionTtlMinutes: config.sessionTtlMinutes,
        maxSessions: config.maxSessions,
        fallbackEnabled: config.fallbackEnabled,
        defaultModel: config.defaultModel,
        skipConnectionTest: config.skipConnectionTest,
        circuitBreakerThreshold: config.circuitBreakerThreshold,
        circuitBreakerResetTimeout: config.circuitBreakerResetTimeout,
        maxSessionMessages: config.maxSessionMessages,
        enableMultimodal: config.enableMultimodal,
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(safeConfig, null, 2),
          },
        ],
      };
    }
  );
}
