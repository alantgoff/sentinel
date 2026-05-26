#!/usr/bin/env node
/**
 * Sentinel MCP server.
 *
 * Exposes the kit's built-in tools AND the Sentinel plugin's tools
 * (sentinel_evaluate_payment, sentinel_get_counterparty_reputation, etc.)
 * over the Model Context Protocol on stdio.
 *
 * Run with an MCP-aware client (Claude Desktop, Anthropic SDK, etc.):
 *
 *   { "command": "node",
 *     "args": ["src/mcp-server.js"],
 *     "cwd": "/path/to/sentinel",
 *     "env": { ...same vars as .env... } }
 *
 * The kit's HederaMCPToolkit auto-registers every Tool from every loaded
 * plugin, so Sentinel's policy + reputation tools are available to any MCP
 * client without further wiring.
 */
import { HederaMCPToolkit, AgentMode } from 'hedera-agent-kit';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { buildClient } from './hedera/client.js';
import { createMirrorClient } from './hedera/mirror.js';
import { createSentinelPlugin } from './plugin/index.js';

async function main() {
  const cfg = loadConfig();
  if (!cfg.SENTINEL_TOPIC_ID) {
    throw new Error('SENTINEL_TOPIC_ID is required to run the MCP server. Run `npm run smoke:hcs` first.');
  }

  const client = buildClient({
    network: cfg.HEDERA_NETWORK,
    accountId: cfg.BUYER_ACCOUNT_ID,
    privateKey: cfg.BUYER_PRIVATE_KEY,
  });
  const mirror = createMirrorClient({ baseUrl: cfg.MIRROR_NODE_URL });

  /** @type {import('./plugin/types.js').PolicyConfig} */
  const policy = {
    autonomousCapHbar: cfg.DEFAULT_AUTONOMOUS_CAP_HBAR,
    dailyLimitHbar: cfg.DEFAULT_DAILY_LIMIT_HBAR,
    velocityWindowSeconds: cfg.DEFAULT_VELOCITY_WINDOW_SECONDS,
    velocityMaxTxns: cfg.DEFAULT_VELOCITY_MAX_TXNS,
    serviceAllowlist: ['funding-round-lookup'],
  };

  const plugin = createSentinelPlugin({ mirror, topicId: cfg.SENTINEL_TOPIC_ID, policy });

  const mcp = new HederaMCPToolkit({
    client,
    configuration: {
      plugins: [plugin],
      context: {
        accountId: cfg.BUYER_ACCOUNT_ID,
        mode: AgentMode.AUTONOMOUS,
      },
    },
  });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  // stderr-only logging so we don't corrupt the stdio MCP channel.
  console.error('Sentinel MCP server connected via stdio.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
