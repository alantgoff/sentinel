#!/usr/bin/env node
/**
 * End-to-end policy lifecycle smoke test (testnet).
 *
 * Runs the full Aegis flow against real Hedera testnet:
 *   1. quote a 30-day cap (K, Q, window via CLI args or defaults)
 *   2. buyer transfers premium HBAR to the underwriter (kit transfer_hbar_tool, AUTONOMOUS)
 *   3. underwriter verifies premium on the mirror, checks exposure, posts POLICY envelope
 *   4. inject a shock so R jumps above K
 *   5. advance the feed to the policy's expiry
 *   6. underwriter computes the payout and either:
 *        - autonomously transfers + posts SETTLEMENT (if payout ≤ PAYOUT_AUTONOMOUS_CAP_HBAR), or
 *        - returns unsigned bytes (RETURN_BYTES); we then call finalizeApprovedPayout
 *          to simulate the human-in-loop approval
 *
 * All HCS envelopes + tx ids are logged so they can be cross-checked on
 * HashScan or the mirror node REST API.
 *
 * Usage:
 *   node scripts/lifecycle-smoke.js [strike=4] [qty=100] [window=30] [shock=1.8]
 */
import { bootstrapAegis } from '../src/bootstrap.js';

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const strike = Number(process.argv[2] ?? '4');
  const qty = Number(process.argv[3] ?? '100');
  const window = Number(process.argv[4] ?? '30');
  const shock = Number(process.argv[5] ?? '1.8');

  const aegis = bootstrapAegis({
    feedTickMs: 60_000,                        // slow ticking — we'll advance manually
    onSubmit: (env) => console.log(`[hcs] ${env.type}${env.policyId ? ' '+env.policyId : ''}`),
  });

  log('config', {
    network: aegis.cfg.HEDERA_NETWORK,
    topicId: aegis.cfg.AEGIS_TOPIC_ID,
    buyer: aegis.buyerAccountId,
    underwriter: aegis.underwriterAccountId,
    R0: aegis.priceFeed.getRT(),
    autonomousPayoutCap: aegis.cfg.PAYOUT_AUTONOMOUS_CAP_HBAR + ' HBAR',
  });

  log(`1. QUOTE  K=$${strike}/hr, Q=${qty} GPU-hr, window=${window}d`, '');
  const quote = await aegis.buyer.requestQuote({
    strikeUsdHr: strike, qtyGpuHr: qty, windowDays: window, seed: Date.now(),
  });
  log('quote', {
    premiumHbar: quote.premiumHbar,
    expectedPayoutHbar: quote.expectedPayoutHbar,
    riskLoadHbar: quote.riskLoadHbar,
    opsLoadHbar: quote.opsLoadHbar,
    probInTheMoney: quote.probInTheMoney,
    maxPayoutHbar: quote.maxPayoutHbar,
    R0: quote.R0,
  });

  log('2. PAY PREMIUM', '');
  const { txId: premiumTxId } = await aegis.buyer.payPremium({
    premiumHbar: quote.premiumHbar,
    memo: `aegis/premium/K=${strike}/Q=${qty}/W=${window}d`,
  });
  log('premium tx', premiumTxId);

  log('3. ISSUE POLICY', '');
  const issued = await aegis.buyer.requestIssue({
    strikeUsdHr: strike,
    qtyGpuHr: qty,
    windowDays: window,
    premiumHbar: quote.premiumHbar,
    premiumTxId,
    maxPayoutHbar: quote.maxPayoutHbar,
  });
  log('issued envelope', {
    sequenceNumber: issued.sequenceNumber,
    policyId: issued.envelope.policyId,
    windowEndsTs: issued.envelope.windowEndsTs,
    exposure: issued.exposure,
  });

  log(`4. INJECT SHOCK ×${shock}`, '');
  aegis.priceFeed.injectShock(shock);
  log('R after shock', aegis.priceFeed.getRT());

  log('5. FAST-FORWARD TO EXPIRY', '');
  aegis.priceFeed.advance(window);
  const RAtExpiry = aegis.priceFeed.getRT();
  log('R at expiry', RAtExpiry);

  log('6. SETTLE', '');
  const settled = await aegis.underwriter.settle({
    policyId: issued.envelope.policyId,
    buyer: aegis.buyerAccountId,
    observedUsdHr: RAtExpiry,
    strikeUsdHr: strike,
    qtyGpuHr: qty,
    maxPayoutHbar: quote.maxPayoutHbar,
    hbarUsdPrice: aegis.hbarUsdPrice,
  });
  log('settle outcome', settled);

  if (settled.kind === 'PAYOUT_AWAITING_APPROVAL') {
    log('  ↳ payout exceeds autonomous cap; simulating human approval', '');
    const final = await aegis.underwriter.finalizeApprovedPayout({
      policyId: settled.policyId,
      buyer: aegis.buyerAccountId,
      observedUsdHr: settled.observedUsdHr,
      payoutHbar: settled.payoutHbar,
    });
    log('finalized', final);
  }

  aegis.close();
  console.log('\nLifecycle smoke OK.');
}

main().catch((err) => {
  console.error('\nLifecycle smoke FAILED:\n');
  console.error(err?.stack ?? err);
  process.exit(1);
});
