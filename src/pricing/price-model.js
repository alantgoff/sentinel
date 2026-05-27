import { createRng } from './rng.js';

/**
 * Mean-reverting jump-diffusion model for the H100 GPU-hour rental rate `R`,
 * with OPTIONAL regime-switching extension (Janczura-Weron / Geman-Roncoroni
 * style — separate "stable" and "squeeze" states with state-dependent vol
 * and jump intensity, glued by a continuous-time Markov chain).
 *
 * SINGLE-REGIME mode (back-compat — params with no `regimes` field):
 *
 *   log R[t+1] = log R[t] + κ (θ − log R[t]) Δt + σ √Δt · Z + J[t]
 *
 *   - κ            mean reversion speed (per year)
 *   - θ            long-run mean of log R (= log of long-run price)
 *   - σ            diffusion vol (per √year)
 *   - J[t]         either 0 (prob 1 − λΔt) or N(μ_J, σ_J²) when a jump fires
 *   - λ            jump intensity (per year)
 *
 * TWO-REGIME mode (params with a `regimes` field):
 *
 *   At each step, the regime r[t] ∈ {0 stable, 1 squeeze} updates via a
 *   Markov chain with daily transition probabilities derived from the
 *   annualized rates `stableToSqueezePerYear` / `squeezeToStablePerYear`.
 *   The diffusion / jump params (σ, λ, μ_J, σ_J) are then read from
 *   regimes[r[t]] and applied to that day's increment. Reversion (κ, θ)
 *   stays shared — the long-run equilibrium doesn't move; only the
 *   short-term variance regime does.
 *
 * Why two regimes for this asset class: real H100 rental history shows
 * qualitatively different behavior in shortage vs normal periods —
 * during the 2023-Q3 shortage and 2024-Q2 Llama squeeze, both vol and jump
 * intensity were materially higher than between shocks. A single-regime
 * fit averages those out and either under-prices ATM premium in stable
 * times or over-prices it during quiet ones. Regime-switching is the
 * established remedy: Janczura-Weron 2010, Cartea-Figueroa 2005,
 * Geman-Roncoroni 2006, Bégin et al. 2025.
 *
 * @typedef {object} RegimeParams
 * @property {string} name              human-readable label (e.g. 'stable', 'squeeze')
 * @property {number} sigma             diffusion vol, per √year, IN this regime
 * @property {number} lambda            jump intensity, per year, IN this regime
 * @property {number} jumpMeanLog
 * @property {number} jumpStdLog
 *
 * @typedef {object} TransitionRates
 * @property {number} stableToSqueezePerYear     annualized rate of entering squeeze from stable
 * @property {number} squeezeToStablePerYear     annualized rate of exiting squeeze
 *
 * @typedef {object} PriceModelParams
 * @property {number} kappa           mean reversion speed, per year (e.g. 1.5)
 * @property {number} thetaLog        long-run mean of log R (e.g. log(2.30))
 * @property {number} sigma           single-regime diffusion vol (used if `regimes` is unset)
 * @property {number} lambda          single-regime jump intensity (used if `regimes` is unset)
 * @property {number} jumpMeanLog     single-regime
 * @property {number} jumpStdLog      single-regime
 * @property {[RegimeParams, RegimeParams]} [regimes]         enables two-regime mode
 * @property {TransitionRates} [transitionRates]              required if `regimes` is set
 * @property {number} [initialSqueezeProb]                    P(start in squeeze); default = stationary
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

/**
 * Two-regime defaults hand-tuned to real H100 rental history:
 *
 *   - "stable" regime: σ = 0.30/yr, λ ≈ 1/yr — low vol baseline, infrequent
 *     small drifts.
 *   - "squeeze" regime: σ = 0.80/yr, λ = 10/yr, μ_J = +28%, σ_J = 0.18 —
 *     the shortage regime, where short bursts of supply scarcity create
 *     frequent upward jumps.
 *   - transition rates: enter squeeze ~once per 2 years, leave it ~once
 *     per 3 months (stationary squeeze probability ≈ 0.25/(0.25+0.5) =
 *     33% over long horizons, but day-to-day buyer is overwhelmingly in
 *     stable).
 *
 * @type {Readonly<PriceModelParams>}
 */
export const DEFAULT_REGIME_PARAMS = Object.freeze({
  kappa: 1.5,
  thetaLog: Math.log(2.30),
  // single-regime fallback (used if some caller bypasses regimes)
  sigma: 0.45,
  lambda: 4.0,
  jumpMeanLog: 0.20,
  jumpStdLog: 0.12,
  regimes: Object.freeze([
    Object.freeze({ name: 'stable',  sigma: 0.30, lambda: 1.0,  jumpMeanLog: 0.10, jumpStdLog: 0.08 }),
    Object.freeze({ name: 'squeeze', sigma: 0.80, lambda: 10.0, jumpMeanLog: 0.28, jumpStdLog: 0.18 }),
  ]),
  transitionRates: Object.freeze({
    stableToSqueezePerYear: 0.5,    // squeeze starts ~once per 2 years
    squeezeToStablePerYear: 4.0,    // squeeze ends ~once per 3 months
  }),
  initialSqueezeProb: 0,            // demo starts in the stable regime
});

const DAYS_PER_YEAR = 365;

/**
 * Stationary regime probability — useful as a fallback initial distribution.
 * For a two-state CTMC with rates a (0→1) and b (1→0), the stationary
 * probability of state 1 is a/(a+b).
 *
 * @param {TransitionRates} rates
 */
export function stationarySqueezeProb(rates) {
  const a = rates.stableToSqueezePerYear;
  const b = rates.squeezeToStablePerYear;
  return a / (a + b);
}

/**
 * Per-day random draws — one tuple per simulated day. Separating the draws
 * from the integration loop lets us share randomness across paired antithetic
 * paths: the same uniform / Bernoulli + Gaussian-for-jumps + regime-transition
 * draws fire on each pair, but the diffusion Gaussian gets sign-flipped on the
 * partner path. That produces perfectly negatively-correlated diffusion
 * components — what antithetic variates need for variance reduction — while
 * the regime sequence and jump arrivals stay identical across the pair.
 *
 * @typedef {object} DailyDraws
 * @property {number} z         diffusion innovation, N(0, 1)
 * @property {number} u         uniform(0, 1) for the jump Bernoulli
 * @property {number} jz        jump-magnitude innovation, N(0, 1)
 * @property {number} ru        uniform(0, 1) for the regime-transition Bernoulli
 * @property {number} rInit     uniform(0, 1) for the initial regime draw (only [0] is used)
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
    out[t] = { z: rng.nextNormal(), u: rng.next(), jz: rng.nextNormal(), ru: rng.next(), rInit: t === 0 ? rng.next() : 0 };
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

  // SINGLE-REGIME branch: hot path, no regime bookkeeping.
  if (!params.regimes) {
    for (let t = 1; t <= days; t++) {
      const d = draws[t - 1];
      logR += params.kappa * (params.thetaLog - logR) * dt + params.sigma * sqrtDt * (sign * d.z);
      if (d.u < params.lambda * dt) {
        logR += params.jumpMeanLog + params.jumpStdLog * d.jz;
      }
      path[t] = Math.exp(logR);
    }
    return path;
  }

  // TWO-REGIME branch: Markov chain across the path. Regime sequence is
  // driven by `d.ru`; same draws → same regime sequence → antithetic pair
  // walks the same regime path with sign-flipped diffusion increments.
  const [stable, squeeze] = params.regimes;
  const rates = params.transitionRates;
  if (!rates) throw new Error('two-regime params require transitionRates');
  // Daily transition probabilities derived from annualized rates:
  //   P(jump 0→1 this day) = 1 - exp(-a·dt) ≈ a·dt for small dt
  const p01 = 1 - Math.exp(-rates.stableToSqueezePerYear * dt);
  const p10 = 1 - Math.exp(-rates.squeezeToStablePerYear * dt);
  // Initial regime: caller can pin via initialSqueezeProb, default = stationary.
  const initialSqueezeProb = params.initialSqueezeProb ?? stationarySqueezeProb(rates);
  let regime = (draws[0]?.rInit ?? 0.5) < initialSqueezeProb ? 1 : 0;

  for (let t = 1; t <= days; t++) {
    const d = draws[t - 1];
    // Transition first (so day-t increments use day-t's regime).
    const transProb = regime === 0 ? p01 : p10;
    if (d.ru < transProb) regime = 1 - regime;
    const cur = regime === 0 ? stable : squeeze;
    logR += params.kappa * (params.thetaLog - logR) * dt + cur.sigma * sqrtDt * (sign * d.z);
    if (d.u < cur.lambda * dt) {
      logR += cur.jumpMeanLog + cur.jumpStdLog * d.jz;
    }
    path[t] = Math.exp(logR);
  }
  return path;
}

/**
 * Return the regime sequence (0=stable, 1=squeeze) for a draws stream under
 * given params. Useful for the UI (color the chart by regime) and for tests.
 *
 * @param {object} args
 * @param {DailyDraws[]} args.draws
 * @param {PriceModelParams} args.params
 * @returns {Uint8Array}
 */
export function regimeSequence({ draws, params }) {
  if (!params.regimes) return new Uint8Array(draws.length + 1);
  const days = draws.length;
  const out = new Uint8Array(days + 1);
  const rates = params.transitionRates;
  if (!rates) throw new Error('two-regime params require transitionRates');
  const dt = 1 / DAYS_PER_YEAR;
  const p01 = 1 - Math.exp(-rates.stableToSqueezePerYear * dt);
  const p10 = 1 - Math.exp(-rates.squeezeToStablePerYear * dt);
  const initialSqueezeProb = params.initialSqueezeProb ?? stationarySqueezeProb(rates);
  let regime = (draws[0]?.rInit ?? 0.5) < initialSqueezeProb ? 1 : 0;
  out[0] = regime;
  for (let t = 1; t <= days; t++) {
    const transProb = regime === 0 ? p01 : p10;
    if (draws[t - 1].ru < transProb) regime = 1 - regime;
    out[t] = regime;
  }
  return out;
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
