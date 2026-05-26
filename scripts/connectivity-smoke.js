#!/usr/bin/env node
/**
 * Connectivity smoke test — task M1b in HANDOFF.
 *
 * Verifies:
 *   1. The Hedera Agent Kit is importable and AgentMode resolves to its real values.
 *   2. Our .env credentials build a valid testnet client.
 *   3. The kit's account/balance tool can answer "what is my balance?" against testnet.
 *
 * Runs autonomously — no LLM in the loop here. The buyer/seller agents
 * (src/agents/*) wire the kit to an actual chat model.
 */
import { AgentMode, HederaLangchainToolkit } from 'hedera-agent-kit';
import { loadConfig } from '../src/config.js';
import { buildClient } from '../src/hedera/client.js';

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(value);
}

async function main() {
  const cfg = loadConfig();

  log('AgentMode enum (resolved at runtime)', AgentMode);

  const client = buildClient({
    network: cfg.HEDERA_NETWORK,
    accountId: cfg.BUYER_ACCOUNT_ID,
    privateKey: cfg.BUYER_PRIVATE_KEY,
  });

  const toolkit = new HederaLangchainToolkit({
    client,
    configuration: {
      context: {
        accountId: cfg.BUYER_ACCOUNT_ID,
        mode: AgentMode.AUTONOMOUS,
      },
    },
  });

  const tools = toolkit.getTools();
  log(`Kit exposed ${tools.length} built-in tools (names)`, tools.map((t) => t.name));

  const api = toolkit.getHederaAgentKitAPI();
  const balance = await api.run('get_hbar_balance_query_tool', {
    accountId: cfg.BUYER_ACCOUNT_ID,
  });
  log(`HBAR balance for ${cfg.BUYER_ACCOUNT_ID}`, balance);

  client.close();
  console.log('\nConnectivity OK.');
}

main().catch((err) => {
  console.error('\nConnectivity smoke FAILED:\n');
  console.error(err?.stack ?? err);
  process.exit(1);
});
