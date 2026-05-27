#!/usr/bin/env node
/**
 * Aegis MCP server.
 *
 * Exposes the kit's built-in tools AND the Aegis plugin's tools
 * (aegis_quote_policy, aegis_issue_policy, aegis_settle_policy, etc.)
 * over the Model Context Protocol on stdio.
 *
 * Run with an MCP-aware client (Claude Desktop, Anthropic SDK, etc.):
 *
 *   { "command": "node",
 *     "args": ["src/mcp-server.js"],
 *     "cwd": "/path/to/aegis",
 *     "env": { ...same vars as .env... } }
 *
 * The kit's HederaMCPToolkit auto-registers every Tool from every loaded
 * plugin, so Aegis's tools are available to any MCP client without any
 * further wiring.
 */
import { HederaMCPToolkit, AgentMode, coreAccountPlugin } from 'hedera-agent-kit';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { buildClient } from './hedera/client.js';
import { createMirrorClient } from './hedera/mirror.js';
import { createExposureBook } from './pool/exposure.js';
import { createSimFeed } from './pricing/feed.js';
import { DEFAULT_PARAMS } from './pricing/price-model.js';
import { createAegisPlugin } from './plugin/index.js';

async function main() {
  const cfg = loadConfig();
  if (!cfg.AEGIS_TOPIC_ID) {
    throw new Error('AEGIS_TOPIC_ID is required to run the MCP server. Run `npm run smoke:hcs` first.');
  }

  const client = buildClient({
    network: cfg.HEDERA_NETWORK,
    accountId: cfg.UNDERWRITER_ACCOUNT_ID ?? cfg.BUYER_ACCOUNT_ID,
    privateKey: cfg.UNDERWRITER_PRIVATE_KEY ?? cfg.BUYER_PRIVATE_KEY,
  });
  const mirror = createMirrorClient({ baseUrl: cfg.MIRROR_NODE_URL });
  const exposure = createExposureBook({ maxExposureRatio: cfg.MAX_EXPOSURE_RATIO });
  const priceFeed = createSimFeed({
    R0: cfg.DEFAULT_R0_USD_HR,
    horizonDays: 365,
    tickMs: 60_000,                // slow ticking — MCP clients call on-demand
    params: DEFAULT_PARAMS,
  });

  const plugin = createAegisPlugin({
    mirror,
    topicId: cfg.AEGIS_TOPIC_ID,
    underwriterAccountId: cfg.UNDERWRITER_ACCOUNT_ID ?? cfg.BUYER_ACCOUNT_ID,
    exposure,
    priceFeed,
    hbarUsdPrice: 0.05,
    params: DEFAULT_PARAMS,
    paths: 5000,
  });

  const mcp = new HederaMCPToolkit({
    client,
    configuration: {
      plugins: [coreAccountPlugin, plugin],
      context: {
        accountId: cfg.UNDERWRITER_ACCOUNT_ID ?? cfg.BUYER_ACCOUNT_ID,
        mode: AgentMode.AUTONOMOUS,
      },
    },
  });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  // stderr-only logging so we don't corrupt the stdio MCP channel.
  console.error('Aegis MCP server connected via stdio.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
