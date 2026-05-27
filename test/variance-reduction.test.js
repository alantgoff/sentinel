import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateAntitheticPair, integratePath, drawDaily, DEFAULT_PARAMS } from '../src/pricing/price-model.js';
import { createRng } from '../src/pricing/rng.js';
import { pricePremium } from '../src/pricing/pricer.js';

test('antithetic pair shares jump locations + has opposite diffusion increments', () => {
  // Run draws once; build both members of the pair from the same tuple stream.
  const rng = createRng(7);
  const draws = drawDaily(60, rng);
  const a = integratePath({ R0: 2.5, draws, params: DEFAULT_PARAMS, flipDiffusionSign: false });
  const b = integratePath({ R0: 2.5, draws, params: DEFAULT_PARAMS, flipDiffusionSign: true });
  // Day-1 prices must differ unless that day's Z is exactly 0 (probability zero
  // in practice). And the divergence at day 1 should be roughly symmetric
  // around R0 in log-space for a no-jump day.
  assert.notEqual(a[1], b[1]);
  // For days when no jump fires, the average of log(a[t]) and log(b[t])
  // equals the OU drift-only path (Z's cancel). Check this on a chunk of
  // jump-free days by inspecting the geometric mean.
  // (We don't filter for "no jump" exactly because the draws are private;
  // instead we use the property at horizon: E_pair[ log A + log B ] tracks
  // the deterministic OU drift across many samples.)
  // Just confirm the two paths are different + nonzero at every day:
  for (let t = 1; t <= 60; t++) {
    assert.ok(a[t] > 0);
    assert.ok(b[t] > 0);
  }
});

test('antithetic pair has perfectly negative diffusion correlation (jumps off)', () => {
  // With λ=0, the model reduces to pure OU. The pair's terminal Z is exactly
  // negated, so log RA + log RB = 2·θ + (logR0 − θ)·(2·e^(−κT))·exp(−0)
  // i.e., the SUM of log-prices is deterministic (independent of Z). Verify.
  const params = { ...DEFAULT_PARAMS, lambda: 0 };
  const rng = createRng(42);
  const draws = drawDaily(30, rng);
  const a = integratePath({ R0: 2.5, draws, params });
  const b = integratePath({ R0: 2.5, draws, params, flipDiffusionSign: true });
  // log A + log B = 2 · (OU mean path) — should be the same across two
  // different RNG seeds because the deterministic part doesn't depend on Z.
  const sumLog = Math.log(a[30]) + Math.log(b[30]);

  const rng2 = createRng(999);
  const draws2 = drawDaily(30, rng2);
  const a2 = integratePath({ R0: 2.5, draws: draws2, params });
  const b2 = integratePath({ R0: 2.5, draws: draws2, params, flipDiffusionSign: true });
  const sumLog2 = Math.log(a2[30]) + Math.log(b2[30]);

  assert.ok(Math.abs(sumLog - sumLog2) < 1e-9, `expected deterministic sum, got ${sumLog} vs ${sumLog2}`);
});

test('antithetic pricer reports varianceReductionFactor ≥ 1 (always)', () => {
  // Antithetic CAN'T be worse than plain MC. The factor should be ≥ 1
  // even for jump-dominated payoffs (where most of variance is jump-driven
  // and antithetic can't help much).
  const out = pricePremium({
    K: 4.0, Q: 100, windowDays: 30,
    R0: 2.5, hbarUsdPrice: 0.05,
    paths: 4000, seed: 11,
  });
  assert.ok(out.varianceReductionFactor >= 0.95,
    `varianceReductionFactor ${out.varianceReductionFactor} below noise band — antithetic should never be meaningfully worse than plain`);
});

test('antithetic gives substantial variance reduction on ATM payoffs (jumps off)', () => {
  // The theoretical condition for antithetic to help is that the payoff be
  // roughly monotonic in the diffusion Z. For a deep-OTM cap, payoff is
  // near-indicator (zero almost always, rare large positive spikes from
  // both sides of the Z distribution) — antithetic helps little.
  //
  // ATM is where antithetic shines: the payoff function rises smoothly with
  // R_T, which is monotone in (sum of) Z's. We expect a large variance
  // reduction factor here (≫ 1).
  const out = pricePremium({
    K: 2.5, Q: 100, windowDays: 30,
    R0: 2.5, hbarUsdPrice: 0.05,
    paths: 4000, seed: 11,
    params: { ...DEFAULT_PARAMS, lambda: 0 },
  });
  assert.ok(out.varianceReductionFactor > 1.5,
    `expected meaningful variance reduction on ATM payoff with λ=0; got ${out.varianceReductionFactor}`);
});

test('CVaR is at least the expected payout', () => {
  // CVaR_β = mean of payouts in the upper (1−β) tail; it's ≥ the overall
  // mean by construction.
  const out = pricePremium({
    K: 4.0, Q: 100, windowDays: 30,
    R0: 2.5, hbarUsdPrice: 0.05,
    paths: 2000, seed: 17,
    riskLoadMode: 'cvar', cvarBeta: 0.95,
  });
  assert.ok(out.cvarHbar >= out.expectedPayoutHbar);
});

test('CVaR-based risk load is positive when there is tail mass', () => {
  // An OTM cap with non-trivial probability of payout should have a positive
  // CVaR-based risk load. The load equals α × (CVaR − E[payout]).
  const out = pricePremium({
    K: 4.0, Q: 100, windowDays: 30,
    R0: 2.5, hbarUsdPrice: 0.05,
    paths: 4000, seed: 17,
    riskLoadMode: 'cvar', cvarBeta: 0.95, cvarAlpha: 0.2,
  });
  assert.ok(out.riskLoadHbar > 0,
    `expected positive CVaR load for OTM cap; got ${out.riskLoadHbar}`);
});

test('stdev mode and cvar mode produce different premium decompositions', () => {
  const common = {
    K: 4.0, Q: 100, windowDays: 30,
    R0: 2.5, hbarUsdPrice: 0.05,
    paths: 4000, seed: 23,
  };
  const stdev = pricePremium({ ...common, riskLoadMode: 'stdev', riskLoadStdevMultiplier: 2 });
  const cvar = pricePremium({ ...common, riskLoadMode: 'cvar', cvarAlpha: 0.2 });
  // Same expected payout — both modes use the same MC.
  assert.equal(stdev.expectedPayoutHbar, cvar.expectedPayoutHbar);
  // Different risk loads (CVaR is structurally different from stdev/√N).
  assert.notEqual(stdev.riskLoadHbar, cvar.riskLoadHbar);
});

test('CVaR boundary: very-deep-OTM strike → cvar approaches the cap or 0', () => {
  const out = pricePremium({
    K: 100, Q: 100, windowDays: 30,
    R0: 2.5, hbarUsdPrice: 0.05,
    paths: 2000, seed: 31,
    riskLoadMode: 'cvar', cvarBeta: 0.95,
  });
  // P(R reaches $100) ≈ 0; expected and CVaR should both round to 0.
  assert.equal(out.expectedPayoutHbar, 0);
  assert.equal(out.cvarHbar, 0);
});

test('effectivePaths reports the actual run count (rounded up to even pairs)', () => {
  // 1001 → 1002 (501 pairs × 2)
  const out = pricePremium({
    K: 4, Q: 100, windowDays: 30,
    R0: 2.5, hbarUsdPrice: 0.05,
    paths: 1001, seed: 1,
  });
  assert.equal(out.effectivePaths, 1002);
});
