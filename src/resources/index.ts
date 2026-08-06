/**
 * Resource Registration Aggregator
 * Registers all MCP resources with the server
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerModelsResource } from './models.js';
import { registerConfigResource } from './config.js';
import { registerUsageResource } from './usage.js';

export function registerAllResources(server: McpServer): void {
  registerModelsResource(server);
  registerConfigResource(server);
  registerUsageResource(server);
}
