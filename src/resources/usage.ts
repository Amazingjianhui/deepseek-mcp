/**
 * Resource: deepseek://usage
 * Dynamic resource showing real-time usage statistics
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UsageTracker } from '../usage-tracker.js';

export function registerUsageResource(server: McpServer): void {
  server.registerResource(
    'usage',
    'deepseek://usage',
    {
      title: 'DeepSeek Usage Statistics',
      description:
        'Real-time usage statistics including total requests, token consumption, costs, active sessions, and cache hit ratio. Updated on every read.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const tracker = UsageTracker.getInstance();
      const stats = tracker.getStats();
      const cacheHitRatio = tracker.getCacheHitRatio();

      const usageData = {
        ...stats,
        cacheHitRatio: parseFloat(cacheHitRatio.toFixed(4)),
        totalCost: parseFloat(stats.totalCost.toFixed(6)),
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(usageData, null, 2),
          },
        ],
      };
    }
  );
}
