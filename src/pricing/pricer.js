import { simulatePath, DEFAULT_PARAMS } from './price-model.js';
import { createRng } from './rng.js';

/**
 * European-style cap option pricer via Monte Carlo.
 *
 *   premium = expected_payout + risk_load + ops_load
 *   expected_payout = E[ max(0, R_T − K) ] × Q
 *
 * Where:
 *   K   strike (USD/hr)
 *   Q   notional (GPU-hours covered)
 *   T   window length (days)
 *   R_T is the underlying price at expiry, simulated under the jump-diffusion
 *
 * `risk_load` is a multiple of the path-wise stdev / √N (the insurer's
 * uncertainty haircut — wider CI ⇒ bigger load). `ops_load` is a flat % of
 * expected payout for operational overhead. Both transparent and tunable.
 *
 * The returned object includes the 95% CI on expected_payout in HBAR so the
 * UI can show "premium = $X ± $Y; we ran N paths".
 *
 * @param {object} args
 * @param {number} args.K                 strike, USD/hr (positive)
 * @param {number} args.Q                 notional, GPU-hours (positive)
 * @param {number} args.windowDays        coverage window in days (>= 1)
 * @param {number} args.R0                spot price today, USD/hr (positive)
 * @param {number} args.hbarUsdPrice      e.g. 0.05 USD per HBAR
 * @param {number} [args.paths=20000]     Monte Carlo paths (≥ 100)
 * @param {number} [args.maxPayoutCapUsd] optional cap on per-path payout (USD)
 * @param {number} [args.riskLoadStdevMultiplier=2.0]   risk_load multiplier on stdev/√N
 * @param {number} [args.opsLoadFraction=0.05]          ops_load as fraction of expected_payout
 * @param {import('./price-model.js').PriceModelParams} [args.params=DEFAULT_PARAMS]
 * @param {number | bigint} [args.seed]   for deterministic pricing
 * @returns {{
 *   premiumHbar: number,
 *   premiumUsd: number,
 *   expectedPayoutHbar: number,
 *   expectedPayoutUsd: number,
 *   riskLoadHbar: number,
 *   opsLoadHbar: number,
 *   ci95Hbar: [number, number],
 *   probInTheMoney: number,
 *   paths: number,
 *   meanRT: number,
 *   stdRT: number,
 *   params: import('./price-model.js').PriceModelParams,
 * }}
 */
export function pricePremium({
  K,
  Q,
  windowDays,
  R0,
  hbarUsdPrice,
  paths = 20_000,
  maxPayoutCapUsd,
  riskLoadStdevMultiplier = 2.0,
  opsLoadFraction = 0.05,
  params = DEFAULT_PARAMS,
  seed,
}) {
  if (!(K > 0)) throw new Error('K must be positive');
  if (!(Q > 0)) throw new Error('Q must be positive');
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error('windowDays must be a positive integer');
  if (!(R0 > 0)) throw new Error('R0 must be positive');
  if (!(hbarUsdPrice > 0)) throw new Error('hbarUsdPrice must be positive');
  if (!Number.isInteger(paths) || paths < 100) throw new Error('paths must be an integer ≥ 100');

  const rng = createRng(seed);

  let sumPayoutUsd = 0;
  let sumPayoutSqUsd = 0;
  let sumRT = 0;
  let sumRTsq = 0;
  let inTheMoney = 0;

  const cap = typeof maxPayoutCapUsd === 'number' ? maxPayoutCapUsd : Infinity;

  for (let i = 0; i < paths; i++) {
    const path = simulatePath({ R0, days: windowDays, params, rng });
    const RT = path[windowDays];
    sumRT += RT;
    sumRTsq += RT * RT;
    const exceed = Math.max(0, RT - K);
    if (exceed > 0) inTheMoney += 1;
    const payoutUsd = Math.min(exceed * Q, cap);
    sumPayoutUsd += payoutUsd;
    sumPayoutSqUsd += payoutUsd * payoutUsd;
  }

  const meanPayoutUsd = sumPayoutUsd / paths;
  const varPayoutUsd = Math.max(0, sumPayoutSqUsd / paths - meanPayoutUsd * meanPayoutUsd);
  const stdevPayoutUsd = Math.sqrt(varPayoutUsd);
  const seMeanPayoutUsd = stdevPayoutUsd / Math.sqrt(paths);

  const meanRT = sumRT / paths;
  const varRT = Math.max(0, sumRTsq / paths - meanRT * meanRT);
  const stdRT = Math.sqrt(varRT);

  const expectedPayoutUsd = meanPayoutUsd;
  const riskLoadUsd = riskLoadStdevMultiplier * seMeanPayoutUsd;
  const opsLoadUsd = opsLoadFraction * expectedPayoutUsd;
  const premiumUsd = expectedPayoutUsd + riskLoadUsd + opsLoadUsd;

  const toHbar = (usd) => usd / hbarUsdPrice;

  // 95% normal CI on expected payout (large-N approximation).
  const ci95Usd = [
    Math.max(0, expectedPayoutUsd - 1.96 * seMeanPayoutUsd),
    expectedPayoutUsd + 1.96 * seMeanPayoutUsd,
  ];

  return {
    premiumHbar: round8(toHbar(premiumUsd)),
    premiumUsd: round4(premiumUsd),
    expectedPayoutHbar: round8(toHbar(expectedPayoutUsd)),
    expectedPayoutUsd: round4(expectedPayoutUsd),
    riskLoadHbar: round8(toHbar(riskLoadUsd)),
    opsLoadHbar: round8(toHbar(opsLoadUsd)),
    ci95Hbar: [round8(toHbar(ci95Usd[0])), round8(toHbar(ci95Usd[1]))],
    probInTheMoney: inTheMoney / paths,
    paths,
    meanRT: round4(meanRT),
    stdRT: round4(stdRT),
    params,
  };
}

function round8(x) { return Math.round(x * 1e8) / 1e8; }
function round4(x) { return Math.round(x * 1e4) / 1e4; }

/**
 * The maximum possible payout in HBAR for sizing pool reserves.
 *
 * In principle a jump-diffusion process is unbounded, but for reservation we
 * use a high quantile of the simulated distribution (default p99) or, if
 * `maxPayoutCapUsd` is set, that cap. Used by the pool/exposure module.
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
  const payouts = new Float64Array(paths);
  const cap = typeof maxPayoutCapUsd === 'number' ? maxPayoutCapUsd : Infinity;
  for (let i = 0; i < paths; i++) {
    const path = simulatePath({ R0, days: windowDays, params, rng });
    const RT = path[windowDays];
    payouts[i] = Math.min(Math.max(0, RT - K) * Q, cap);
  }
  // Quantile via sort.
  const sorted = Array.from(payouts).sort((a, b) => a - b);
  const idx = Math.min(paths - 1, Math.floor(quantile * paths));
  const qUsd = sorted[idx];
  return qUsd / hbarUsdPrice;
}
