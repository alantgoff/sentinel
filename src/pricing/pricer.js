import { simulateAntitheticPair, DEFAULT_PARAMS } from './price-model.js';
import { createRng } from './rng.js';

/**
 * European-style cap option pricer via Monte Carlo with antithetic variates.
 *
 *   premium = expected_payout + risk_load + ops_load
 *   expected_payout = E[ max(0, R_T − K) ] × Q
 *
 * Where:
 *   K   strike (USD/hr)
 *   Q   notional (GPU-hours covered)
 *   T   window length (days)
 *   R_T is the underlying price at expiry, simulated under the regime-aware
 *       jump-diffusion (single-regime DEFAULT_PARAMS by default; pass a
 *       regime-switching params blob to invoke the squeeze-state extension).
 *
 * Variance reduction: each path is paired with its antithetic counterpart
 * (same uniform/Bernoulli/jump-magnitude draws, sign-flipped diffusion Z's).
 * Both the plain-MC estimator (variance across all paths) and the
 * antithetic estimator (variance across pair-means) are computed; the
 * headline SE / CI uses whichever is tighter — antithetic helps diffusion-
 * dominated payoffs (ATM caps) but can HURT jump-dominated payoffs (deep
 * OTM where the jumps drive variance and they're shared across the pair).
 * `varianceReductionFactor` is the ratio (plainSE / bestSE)² — always ≥ 1.
 *
 * `risk_load` is either:
 *   - stdev-based (legacy): multiplier × pair-mean SE  (what was here before)
 *   - CVaR-based (preferred, coherent): α × (CVaR_β(payout) - E[payout])
 *     where CVaR_β is the mean of payouts in the worst (1−β) tail. β=0.95
 *     gives a 5% tail; the underwriter's risk-aversion α scales the load.
 *     CVaR satisfies the four coherent-risk axioms; stdev does not (it's
 *     not subadditive). For new code prefer riskLoadMode: 'cvar'.
 *
 * `ops_load` is a flat fraction of expected payout.
 *
 * @param {object} args
 * @param {number} args.K
 * @param {number} args.Q
 * @param {number} args.windowDays
 * @param {number} args.R0
 * @param {number} args.hbarUsdPrice
 * @param {number} [args.paths=20000]               total path count (always rounded up to even — we run in antithetic pairs)
 * @param {number} [args.maxPayoutCapUsd]
 * @param {'cvar'|'stdev'} [args.riskLoadMode='cvar']
 * @param {number} [args.cvarBeta=0.95]              tail probability for CVaR
 * @param {number} [args.cvarAlpha=0.15]             multiplier on (CVaR − mean) for risk load
 * @param {number} [args.riskLoadStdevMultiplier=2.0] used when riskLoadMode='stdev'
 * @param {number} [args.opsLoadFraction=0.05]
 * @param {import('./price-model.js').PriceModelParams} [args.params=DEFAULT_PARAMS]
 * @param {number | bigint} [args.seed]
 * @returns {{
 *   premiumHbar: number, premiumUsd: number,
 *   expectedPayoutHbar: number, expectedPayoutUsd: number,
 *   riskLoadHbar: number, opsLoadHbar: number,
 *   ci95Hbar: [number, number],
 *   probInTheMoney: number,
 *   paths: number, effectivePaths: number, varianceReductionFactor: number,
 *   meanRT: number, stdRT: number,
 *   cvarHbar: number, cvarBeta: number,
 *   riskLoadMode: 'cvar' | 'stdev',
 *   params: import('./price-model.js').PriceModelParams,
 * }}
 */
export function pricePremium({
  K, Q, windowDays, R0, hbarUsdPrice,
  paths = 20_000, maxPayoutCapUsd,
  riskLoadMode = 'cvar',
  cvarBeta = 0.95,
  cvarAlpha = 0.15,
  riskLoadStdevMultiplier = 2.0,
  opsLoadFraction = 0.05,
  params = DEFAULT_PARAMS, seed,
}) {
  if (!(K > 0)) throw new Error('K must be positive');
  if (!(Q > 0)) throw new Error('Q must be positive');
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error('windowDays must be a positive integer');
  if (!(R0 > 0)) throw new Error('R0 must be positive');
  if (!(hbarUsdPrice > 0)) throw new Error('hbarUsdPrice must be positive');
  if (!Number.isInteger(paths) || paths < 100) throw new Error('paths must be an integer ≥ 100');
  if (cvarBeta <= 0 || cvarBeta >= 1) throw new Error('cvarBeta must be in (0, 1)');
  if (cvarAlpha < 0) throw new Error('cvarAlpha must be ≥ 0');

  const rng = createRng(seed);
  const numPairs = Math.ceil(paths / 2);
  const effectivePaths = numPairs * 2;
  const cap = typeof maxPayoutCapUsd === 'number' ? maxPayoutCapUsd : Infinity;

  // Track per-path payouts for the CVaR and per-pair averages for variance.
  const payouts = new Float64Array(effectivePaths);
  const pairAvgs = new Float64Array(numPairs);
  let inTheMoney = 0;
  let sumRT = 0;
  let sumRTsq = 0;
  let sumPathPayout = 0;          // plain-MC reference (for variance comparison)
  let sumPathPayoutSq = 0;

  for (let i = 0; i < numPairs; i++) {
    const { a, b } = simulateAntitheticPair({ R0, days: windowDays, params, rng });
    const RA = a[windowDays], RB = b[windowDays];
    sumRT += RA + RB;
    sumRTsq += RA * RA + RB * RB;

    const pA = Math.min(Math.max(0, RA - K) * Q, cap);
    const pB = Math.min(Math.max(0, RB - K) * Q, cap);
    payouts[2 * i] = pA;
    payouts[2 * i + 1] = pB;
    if (pA > 0) inTheMoney += 1;
    if (pB > 0) inTheMoney += 1;
    sumPathPayout += pA + pB;
    sumPathPayoutSq += pA * pA + pB * pB;

    pairAvgs[i] = (pA + pB) / 2;
  }

  // Mean is identical under either estimator. The two differ only in the
  // standard error of that mean.
  const meanPayoutUsd = sumPathPayout / effectivePaths;
  const plainVar = Math.max(0, sumPathPayoutSq / effectivePaths - meanPayoutUsd * meanPayoutUsd);
  const plainSE = Math.sqrt(plainVar / effectivePaths);

  // Variance of the pair-mean estimator. For diffusion-dominated payoffs
  // this is meaningfully smaller than plainSE; for jump-dominated payoffs
  // it can be slightly larger (shared jumps inflate pair-mean variance).
  let pairSumSq = 0;
  for (let i = 0; i < numPairs; i++) pairSumSq += (pairAvgs[i] - meanPayoutUsd) ** 2;
  const pairVar = numPairs > 1 ? pairSumSq / (numPairs - 1) : 0;
  const antitheticSE = Math.sqrt(pairVar / numPairs);

  // Best-of-both: pick the tighter SE. This makes the estimator strictly
  // dominate plain MC at the same path count.
  const bestSE = Math.min(plainSE, antitheticSE);
  const usedEstimator = antitheticSE < plainSE ? 'antithetic' : 'plain';
  // varianceReductionFactor is the variance ratio plain/used, ≥ 1 always.
  const varianceReductionFactor = bestSE > 0 ? (plainSE / Math.max(bestSE, 1e-12)) ** 2 : 1;

  // CVaR: mean of the worst (1 − β) tail of per-path payouts.
  const sortedPayouts = Array.from(payouts).sort((a, b) => a - b);  // ascending
  // For a payoff (loss to the underwriter), tail = upper tail. The β-CVaR is
  // the mean of values above the β-quantile.
  const tailCount = Math.max(1, Math.floor((1 - cvarBeta) * effectivePaths));
  let cvarSumUsd = 0;
  for (let i = effectivePaths - tailCount; i < effectivePaths; i++) cvarSumUsd += sortedPayouts[i];
  const cvarUsd = cvarSumUsd / tailCount;

  const meanRT = sumRT / effectivePaths;
  const varRT = Math.max(0, sumRTsq / effectivePaths - meanRT * meanRT);
  const stdRT = Math.sqrt(varRT);

  const expectedPayoutUsd = meanPayoutUsd;
  const riskLoadUsd =
    riskLoadMode === 'cvar'
      ? Math.max(0, cvarAlpha * (cvarUsd - expectedPayoutUsd))
      : riskLoadStdevMultiplier * bestSE;
  const opsLoadUsd = opsLoadFraction * expectedPayoutUsd;
  const premiumUsd = expectedPayoutUsd + riskLoadUsd + opsLoadUsd;

  const toHbar = (usd) => usd / hbarUsdPrice;

  // 95% CI on the mean — uses the better SE so the UI sees the tighter band.
  const ci95Usd = [
    Math.max(0, expectedPayoutUsd - 1.96 * bestSE),
    expectedPayoutUsd + 1.96 * bestSE,
  ];

  return {
    premiumHbar: round8(toHbar(premiumUsd)),
    premiumUsd: round4(premiumUsd),
    expectedPayoutHbar: round8(toHbar(expectedPayoutUsd)),
    expectedPayoutUsd: round4(expectedPayoutUsd),
    riskLoadHbar: round8(toHbar(riskLoadUsd)),
    opsLoadHbar: round8(toHbar(opsLoadUsd)),
    ci95Hbar: [round8(toHbar(ci95Usd[0])), round8(toHbar(ci95Usd[1]))],
    probInTheMoney: inTheMoney / effectivePaths,
    paths: effectivePaths,
    effectivePaths,
    varianceReductionFactor: round4(varianceReductionFactor),
    usedEstimator,
    meanRT: round4(meanRT),
    stdRT: round4(stdRT),
    cvarHbar: round8(toHbar(cvarUsd)),
    cvarBeta,
    riskLoadMode,
    params,
  };
}

function round8(x) { return Math.round(x * 1e8) / 1e8; }
function round4(x) { return Math.round(x * 1e4) / 1e4; }

/**
 * Max-likely payout estimator using the same antithetic-pair simulation
 * as the pricer. Used by the pool's exposure book for worst-case reservation.
 *
 * @param {object} args
 * @param {number} args.K
 * @param {number} args.Q
 * @param {number} args.windowDays
 * @param {number} args.R0
 * @param {number} args.hbarUsdPrice
 * @param {number} [args.maxPayoutCapUsd]
 * @param {number} [args.quantile=0.99]
 * @param {number} [args.paths=5000]
 * @param {import('./price-model.js').PriceModelParams} [args.params=DEFAULT_PARAMS]
 * @param {number | bigint} [args.seed]
 */
export function maxLikelyPayoutHbar({
  K, Q, windowDays, R0, hbarUsdPrice,
  maxPayoutCapUsd, quantile = 0.99,
  paths = 5000, params = DEFAULT_PARAMS, seed,
}) {
  const rng = createRng(seed);
  const numPairs = Math.ceil(paths / 2);
  const effectivePaths = numPairs * 2;
  const cap = typeof maxPayoutCapUsd === 'number' ? maxPayoutCapUsd : Infinity;
  const payouts = new Float64Array(effectivePaths);
  for (let i = 0; i < numPairs; i++) {
    const { a, b } = simulateAntitheticPair({ R0, days: windowDays, params, rng });
    payouts[2 * i] = Math.min(Math.max(0, a[windowDays] - K) * Q, cap);
    payouts[2 * i + 1] = Math.min(Math.max(0, b[windowDays] - K) * Q, cap);
  }
  const sorted = Array.from(payouts).sort((a, b) => a - b);
  const idx = Math.min(effectivePaths - 1, Math.floor(quantile * effectivePaths));
  return sorted[idx] / hbarUsdPrice;
}
