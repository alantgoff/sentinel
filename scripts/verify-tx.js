#!/usr/bin/env node
/**
 * Verify a Hedera transaction id against the mirror node — the same primitive
 * the Aegis settlement state machine uses to confirm premium / payout transfers.
 *
 * Usage:
 *   node scripts/verify-tx.js 0.0.1001@1716736800.123456789
 *   node scripts/verify-tx.js 0.0.1001-1716736800-123456789  # dashed form also accepted
 */
import { loadConfig } from '../src/config.js';
import { createMirrorClient } from '../src/hedera/mirror.js';

async function main() {
  const txId = process.argv[2];
  if (!txId) {
    console.error('Usage: node scripts/verify-tx.js <transactionId>');
    process.exit(2);
  }

  const cfg = loadConfig();
  const mirror = createMirrorClient({ baseUrl: cfg.MIRROR_NODE_URL });
  const result = await mirror.verifyTransaction(txId);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verified ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(2);
});
