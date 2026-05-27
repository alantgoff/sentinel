import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricePremium, maxLikelyPayoutHbar } from '../src/pricing/pricer.js';
import { DEFAULT_PARAMS } from '../src/pricing/price-model.js';

const BASE = {
  K: 4.0,           // strike $4/hr
  Q: 1000,          // 1000 GPU-hours notional
  windowDays: 30,
  R0: 2.5,
  hbarUsdPrice: 0.05,
  paths: 1000,      // small for test speed; production uses 20k
  seed: 42,
};

test('pricePremium returns deterministic results for a fixed seed', () => {
  const a = pricePremium(BASE);
  const b = pricePremium(BASE);
  assert.equal(a.premiumHbar, b.premiumHbar);
  assert.equal(a.expectedPayoutHbar, b.expectedPayoutHbar);
  assert.equal(a.probInTheMoney, b.probInTheMoney);
});

test('premium decomposes consistently: premium ≈ expected + risk + ops', () => {
  const r = pricePremium(BASE);
  const sum = r.expectedPayoutHbar + r.riskLoadHbar + r.opsLoadHbar;
  assert.ok(
    Math.abs(sum - r.premiumHbar) < 1e-6,
    `premium ${r.premiumHbar} != sum ${sum}`,
  );
});

test('higher strike → lower premium (monotone)', () => {
  const low = pricePremium({ ...BASE, K: 2.5 });   // ATM
  const mid = pricePremium({ ...BASE, K: 4.0 });
  const hi = pricePremium({ ...BASE, K: 8.0 });
  assert.ok(low.premiumHbar > mid.premiumHbar, `K=2.5 ${low.premiumHbar} <= K=4 ${mid.premiumHbar}`);
  assert.ok(mid.premiumHbar > hi.premiumHbar, `K=4 ${mid.premiumHbar} <= K=8 ${hi.premiumHbar}`);
});

test('higher notional → proportionally higher premium (linear in Q)', () => {
  const small = pricePremium({ ...BASE, Q: 100 });
  const large = pricePremium({ ...BASE, Q: 10_000 });
  // Within ~5% of 100× ratio (loads are linear in Q via expected_payout).
  const ratio = large.premiumHbar / small.premiumHbar;
  assert.ok(ratio > 95 && ratio < 105, `expected ~100× ratio, got ${ratio}`);
});

test('zero-vol path price collapses toward intrinsic value', () => {
  // With σ ≈ 0 and λ = 0, R drifts deterministically toward exp(thetaLog).
  // Starting at R0 < K below the long-run mean, expected payout should be small.
  const r = pricePremium({
    ...BASE, K: 3.5, paths: 2000,
    params: { ...DEFAULT_PARAMS, sigma: 0.001, lambda: 0 },
  });
  assert.ok(r.expectedPayoutHbar < 0.5, `expected near-zero payout, got ${r.expectedPayoutHbar}`);
});

test('premium with maxPayoutCap is bounded', () => {
  // Cap at $50 → max payout = 50/0.05 = 1000 HBAR per path, so expected
  // payout ≤ 1000 + loads.
  const r = pricePremium({ ...BASE, maxPayoutCapUsd: 50, paths: 2000 });
  assert.ok(r.expectedPayoutHbar < 1100, `expected ≤ 1100 HBAR, got ${r.expectedPayoutHbar}`);
});

test('CI95 brackets the expected payout', () => {
  const r = pricePremium({ ...BASE, paths: 2000 });
  assert.ok(r.ci95Hbar[0] <= r.expectedPayoutHbar);
  assert.ok(r.ci95Hbar[1] >= r.expectedPayoutHbar);
  assert.ok(r.ci95Hbar[1] >= r.ci95Hbar[0]);
});

test('probInTheMoney is a probability in [0, 1]', () => {
  const r = pricePremium(BASE);
  assert.ok(r.probInTheMoney >= 0 && r.probInTheMoney <= 1);
});

test('input validation', () => {
  assert.throws(() => pricePremium({ ...BASE, K: 0 }));
  assert.throws(() => pricePremium({ ...BASE, Q: 0 }));
  assert.throws(() => pricePremium({ ...BASE, windowDays: 0 }));
  assert.throws(() => pricePremium({ ...BASE, R0: -1 }));
  assert.throws(() => pricePremium({ ...BASE, hbarUsdPrice: 0 }));
  assert.throws(() => pricePremium({ ...BASE, paths: 50 }));
});

test('maxLikelyPayoutHbar returns >= 0', () => {
  const m = maxLikelyPayoutHbar({ ...BASE, paths: 1000, seed: 99 });
  assert.ok(m >= 0);
});

test('maxLikelyPayoutHbar respects the explicit cap', () => {
  const m = maxLikelyPayoutHbar({ ...BASE, paths: 1000, maxPayoutCapUsd: 25, seed: 99 });
  // 25 USD / 0.05 HBAR/USD = 500 HBAR ceiling
  assert.ok(m <= 500 + 1e-6, `expected ≤ 500 HBAR with cap, got ${m}`);
});
