#!/usr/bin/env node
/**
 * End-to-end x402 demo. Hits the Sentinel server's seller endpoint over real
 * HTTP, settles the 402 challenge by going through the Sentinel policy plugin
 * (so the policy decision is enforced even when the seller is called via x402),
 * and re-fetches with the X-Payment header.
 *
 * Usage:
 *   npm start                  # in one terminal
 *   node scripts/x402-demo.js  # in another
 */
import { bootstrapSentinel } from '../src/bootstrap.js';
import { x402Fetch } from '../src/x402-client.js';

async function main() {
  const sentinel = bootstrapSentinel();
  const base = sentinel.cfg.PUBLIC_BASE_URL;

  const query = { sector: 'AI Foundation Models', minAmountUsdM: 500, limit: 5 };
  const url = `${base}/seller/api/funding-rounds?query=${encodeURIComponent(JSON.stringify(query))}`;

  console.log(`\n→ GET ${url}\n`);

  const signer = {
    async payQuote(quote) {
      console.log(`   ↳ server returned 402, quote:`, quote);
      const outcome = await sentinel.buyer.payQuote({
        quote: {
          requestId: quote.requestId,
          service: quote.service,
          priceHbar: quote.priceHbar,
          payTo: quote.payTo,
          expiresAt: quote.expiresAt,
        },
      });
      if (outcome.kind !== 'ALLOWED') {
        throw new Error(`policy did not settle the quote: ${outcome.kind} — ${outcome.decision.reason}`);
      }
      console.log(`   ↳ settled with txId ${outcome.txId}`);
      return outcome.txId;
    },
  };

  const { status, data, txId } = await x402Fetch({ url, signer, buyer: sentinel.buyer.accountId });
  console.log(`\n← ${status}`);
  console.log(JSON.stringify(data, null, 2));
  if (txId) console.log(`(settled via ${txId})`);

  sentinel.close();
}

main().catch((err) => {
  console.error('\nx402 demo failed:\n');
  console.error(err?.stack ?? err);
  process.exit(1);
});
