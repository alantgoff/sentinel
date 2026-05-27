import { createRng } from './rng.js';

/**
 * Mean-reverting jump-diffusion model for the H100 GPU-hour rental rate `R`.
 *
 * Discrete daily SDE on log price:
 *
 *   log R[t+1] = log R[t] + κ (θ − log R[t]) Δt + σ √Δt · Z + J[t]
 *
 *   - κ            mean reversion speed (per year)
 *   - θ            long-run mean of log R (= log of long-run price)
 *   - σ            diffusion vol (per √year)
 *   - Z            i.i.d. N(0, 1)
 *   - Δt           1 / 365 (one day)
 *   - J[t]         either 0 (probability 1 − λΔt) or N(μ_J, σ_J²) when a jump fires
 *   - λ            jump intensity (per year)
 *   - μ_J, σ_J     jump-size distribution in log-price (μ_J > 0 ⇒ upward bias)
 *
 * Captures the observed behavior of public H100 rental data 2022–2025:
 *   - long-run downward drift (suppliers add capacity, prices fall)
 *   - mean reversion (a spike doesn't persist; supply chases price)
 *   - rare upward jumps (shortages, fab events, new-model launches)
 *
 * Why this model is the right one for *option pricing*: spikes are what the
 * cap actually pays out on. A pure GBM with negative drift would under-price
 * tail premium; a deterministic decay model would under-price by ignoring
 * variance entirely. Jump-diffusion sits at the right level of detail —
 * tractable Monte Carlo, no closed-form needed.
 *
 * @typedef {object} PriceModelParams
 * @property {number} kappa           mean reversion speed, per year (e.g. 1.5)
 * @property {number} thetaLog        long-run mean of log R (e.g. log(2.30) ≈ 0.83)
 * @property {number} sigma           diffusion vol, per √year (e.g. 0.45)
 * @property {number} lambda          jump intensity, per year (e.g. 4.0 = ~quarterly)
 * @property {number} jumpMeanLog     mean log-jump size (e.g. 0.20 ≈ +22% on average)
 * @property {number} jumpStdLog      std of log-jump size (e.g. 0.12)
 */

/**
 * Reasonable defaults, hand-tuned to public H100 rental data 2022–2025
 * (calibration details in src/pricing/calibration.js). These are
 * intentionally conservative; the calibration module can refine them.
 *
 * @type {PriceModelParams}
 */
export const DEFAULT_PARAMS = Object.freeze({
  kappa: 1.5,
  thetaLog: Math.log(2.30),
  sigma: 0.45,
  lambda: 4.0,
  jumpMeanLog: 0.20,
  jumpStdLog: 0.12,
});

const DAYS_PER_YEAR = 365;

/**
 * Per-day random draws — one tuple per simulated day. Separating the draws
 * from the integration loop lets us share randomness across paired antithetic
 * paths: the same uniform / Bernoulli + Gaussian-for-jumps draws fire on each
 * pair, but the diffusion Gaussian gets sign-flipped on the partner path.
 * That produces perfectly negatively-correlated diffusion components, which
 * is exactly what antithetic variates need for variance reduction.
 *
 * @typedef {object} DailyDraws
 * @property {number} z      diffusion innovation, N(0, 1)
 * @property {number} u      uniform(0, 1) used for the jump Bernoulli
 * @property {number} jz     jump-magnitude innovation, N(0, 1)
 */

/**
 * Generate `days` daily-draw tuples from the RNG. Stable contract: tests +
 * antithetic pairing both rely on this shape.
 *
 * @param {number} days
 * @param {ReturnType<typeof createRng>} rng
 * @returns {DailyDraws[]}
 */
export function drawDaily(days, rng) {
  if (!Number.isInteger(days) || days < 0) throw new Error('days must be a non-negative integer');
  /** @type {DailyDraws[]} */
  const out = new Array(days);
  for (let t = 0; t < days; t++) {
    out[t] = { z: rng.nextNormal(), u: rng.next(), jz: rng.nextNormal() };
  }
  return out;
}

/**
 * Integrate the jump-diffusion SDE day-by-day using a precomputed draw
 * sequence. Pure function — no RNG side effects — so it composes cleanly
 * with variance-reduction wrappers.
 *
 * Pass `flipDiffusionSign = true` to integrate the antithetic partner of an
 * earlier call: the diffusion Z's are negated while the jump Bernoulli and
 * jump-magnitude draws are reused as-is (the standard construction for
 * antithetic variates on jump-diffusion paths — flipping the jump draws too
 * would just be a different sample, not a paired one).
 *
 * @param {object} args
 * @param {number} args.R0
 * @param {DailyDraws[]} args.draws
 * @param {PriceModelParams} [args.params]
 * @param {boolean} [args.flipDiffusionSign=false]
 * @returns {Float64Array}
 */
export function integratePath({ R0, draws, params = DEFAULT_PARAMS, flipDiffusionSign = false }) {
  if (R0 <= 0 || !Number.isFinite(R0)) throw new Error('R0 must be a positive finite number');
  const days = draws.length;
  const dt = 1 / DAYS_PER_YEAR;
  const sqrtDt = Math.sqrt(dt);
  const path = new Float64Array(days + 1);
  let logR = Math.log(R0);
  path[0] = R0;
  const sign = flipDiffusionSign ? -1 : 1;
  for (let t = 1; t <= days; t++) {
    const d = draws[t - 1];
    logR += params.kappa * (params.thetaLog - logR) * dt + params.sigma * sqrtDt * (sign * d.z);
    // Thinning approximation: with probability λΔt, a jump fires this day.
    // For λ ≤ ~50/yr the discretization error is negligible; above that we'd
    // switch to a compound-Poisson loop within the day.
    if (d.u < params.lambda * dt) {
      logR += params.jumpMeanLog + params.jumpStdLog * d.jz;
    }
    path[t] = Math.exp(logR);
  }
  return path;
}

/**
 * Simulate one daily price path. Convenience wrapper around drawDaily +
 * integratePath for callers that don't need to share randomness.
 *
 * Returns the path as a regular Float64Array (cheap; serializable).
 *
 * @param {object} args
 * @param {number} args.R0
 * @param {number} args.days
 * @param {PriceModelParams} [args.params]
 * @param {ReturnType<typeof createRng>} [args.rng]
 * @returns {Float64Array}
 */
export function simulatePath({ R0, days, params = DEFAULT_PARAMS, rng = createRng() }) {
  const draws = drawDaily(days, rng);
  return integratePath({ R0, draws, params });
}

/**
 * Generate an antithetic pair: two paths sharing every uniform / Bernoulli /
 * jump-magnitude draw, but with opposite signs on the diffusion increments.
 * Variance of the mean estimator on (Y₁ + Y₂)/2 is
 *     Var(Y) · (1 + ρ) / 2
 * where ρ = Corr(Y₁, Y₂). For a diffusion-dominated payoff, ρ → −1 and we
 * approach 100% variance reduction; jump-dominated payoffs cap the benefit
 * at the diffusion's share of total variance. Either way, never worse than
 * plain MC — a free win when N is the cost-binding constraint.
 *
 * @param {object} args
 * @param {number} args.R0
 * @param {number} args.days
 * @param {PriceModelParams} [args.params]
 * @param {ReturnType<typeof createRng>} args.rng
 * @returns {{ a: Float64Array, b: Float64Array }}
 */
export function simulateAntitheticPair({ R0, days, params = DEFAULT_PARAMS, rng }) {
  const draws = drawDaily(days, rng);
  const a = integratePath({ R0, draws, params, flipDiffusionSign: false });
  const b = integratePath({ R0, draws, params, flipDiffusionSign: true });
  return { a, b };
}

/**
 * Inject a one-time multiplicative shock at `dayIndex`. The path's R at that
 * day (and every subsequent day in the path) is scaled by `magnitude`; mean
 * reversion then pulls it back over subsequent paths.
 *
 * Use case: the demo's "inject shock" button. We mutate the existing
 * pre-generated path in place for visual continuity.
 *
 * @param {Float64Array} path
 * @param {number} dayIndex
 * @param {number} magnitude       multiplicative factor (>1 = upward shock; e.g. 1.6 = +60%)
 */
export function injectShock(path, dayIndex, magnitude) {
  if (!(path instanceof Float64Array)) throw new Error('path must be a Float64Array');
  if (dayIndex < 0 || dayIndex >= path.length) throw new Error('dayIndex out of bounds');
  if (!(magnitude > 0)) throw new Error('magnitude must be positive');
  for (let i = dayIndex; i < path.length; i++) path[i] *= magnitude;
}

/**
 * Quick statistics over a generated path — used by tests + the UI sparkline.
 *
 * @param {Float64Array} path
 */
export function pathStats(path) {
  if (path.length === 0) return { min: NaN, max: NaN, mean: NaN, last: NaN };
  let min = path[0], max = path[0], sum = 0;
  for (let i = 0; i < path.length; i++) {
    const v = path[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, mean: sum / path.length, last: path[path.length - 1] };
}
