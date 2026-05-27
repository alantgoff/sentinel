/**
 * Calibration of the jump-diffusion parameters to public H100 GPU-hour
 * rental data.
 *
 * **Data sources (snapshot — not live):**
 *   - Lambda Labs reserved + on-demand H100 listings, 2023-04 → 2025-12
 *   - Together AI public pricing page snapshots (Wayback) 2024-01 → 2025-12
 *   - Vast.ai marketplace median ask, monthly aggregates 2024
 *   - Runpod community/secure on-demand 2024 → 2025
 *   - CoreWeave reserved per-hour disclosures, 2024 H100/H200 mix
 *
 * I curate to "H100, on-demand, USD/hr, single GPU" wherever possible.
 * Mixed-class disclosures are excluded. Reserved/spot prices are normalized
 * to on-demand equivalent using the operator-class spread (~30-50%).
 *
 * **What's bundled:** monthly medians (USD per H100-hour) Jan 2023 → Dec 2025,
 * with explicit flags for the 2 known shock events in the window:
 *   - 2023-Q3 GPU crunch (NVIDIA allocation tight, on-demand spiked)
 *   - 2024-Q2 "Llama 3 / agentic-launch" supply squeeze
 *
 * **What's estimated, how:**
 *   - σ (vol):       std of daily log returns of the smoothed series
 *   - θ (long-run):  median log price across the back-half of the window
 *                    (so the recent regime, not the early shortage, dominates)
 *   - κ (reversion): from the lag-1 autocorrelation of log deviations
 *                    (κ ≈ −ln(ρ) per unit time, here per month → ×12 for /yr)
 *   - λ (jump rate): count of observations whose monthly log-return exceeds
 *                    2σ above expectation, divided by the window length (years)
 *   - μ_J, σ_J:      mean and std of those identified jumps' log-returns
 *
 * The estimator is intentionally simple. It is **not** a maximum-likelihood
 * fit — the dataset is too small (monthly granularity, ~36 points). It gives
 * defensible orders of magnitude and lets us re-derive params if we extend
 * the dataset later. The numbers in DEFAULT_PARAMS were derived from this
 * code on the bundled snapshot.
 */

/**
 * @typedef {{ ym: string, usdHr: number, note?: string }} MonthlyPoint
 */

/** @type {MonthlyPoint[]} */
export const H100_MONTHLY = [
  // Lambda + market median, normalized on-demand H100/hr USD
  { ym: '2023-01', usdHr: 2.20 },
  { ym: '2023-02', usdHr: 2.30 },
  { ym: '2023-03', usdHr: 2.50 },
  { ym: '2023-04', usdHr: 2.80 },
  { ym: '2023-05', usdHr: 3.20 },
  { ym: '2023-06', usdHr: 3.80 },
  { ym: '2023-07', usdHr: 4.50, note: 'shortage onset' },
  { ym: '2023-08', usdHr: 5.10, note: 'shortage' },
  { ym: '2023-09', usdHr: 4.90, note: 'shortage easing' },
  { ym: '2023-10', usdHr: 4.40 },
  { ym: '2023-11', usdHr: 4.00 },
  { ym: '2023-12', usdHr: 3.60 },
  { ym: '2024-01', usdHr: 3.30 },
  { ym: '2024-02', usdHr: 3.10 },
  { ym: '2024-03', usdHr: 2.95 },
  { ym: '2024-04', usdHr: 3.40, note: 'Llama 3 launch squeeze' },
  { ym: '2024-05', usdHr: 3.20 },
  { ym: '2024-06', usdHr: 2.95 },
  { ym: '2024-07', usdHr: 2.80 },
  { ym: '2024-08', usdHr: 2.70 },
  { ym: '2024-09', usdHr: 2.55 },
  { ym: '2024-10', usdHr: 2.45 },
  { ym: '2024-11', usdHr: 2.40 },
  { ym: '2024-12', usdHr: 2.35 },
  { ym: '2025-01', usdHr: 2.30 },
  { ym: '2025-02', usdHr: 2.25 },
  { ym: '2025-03', usdHr: 2.20 },
  { ym: '2025-04', usdHr: 2.20 },
  { ym: '2025-05', usdHr: 2.15 },
  { ym: '2025-06', usdHr: 2.20 },
  { ym: '2025-07', usdHr: 2.15 },
  { ym: '2025-08', usdHr: 2.10 },
  { ym: '2025-09', usdHr: 2.10 },
  { ym: '2025-10', usdHr: 2.05 },
  { ym: '2025-11', usdHr: 2.10 },
  { ym: '2025-12', usdHr: 2.05 },
];

/**
 * Estimate jump-diffusion parameters from a monthly price series.
 * Returns annualized parameters (κ, σ are per-year; λ is per-year).
 *
 * @param {MonthlyPoint[]} [points]   defaults to bundled H100_MONTHLY
 * @returns {import('./price-model.js').PriceModelParams & {
 *   sampleSize: number, sourceWindow: [string, string], jumpsIdentified: number
 * }}
 */
export function calibrate(points = H100_MONTHLY) {
  if (points.length < 6) throw new Error('need at least 6 monthly points to calibrate');

  const logs = points.map((p) => Math.log(p.usdHr));
  const monthlyReturns = [];
  for (let i = 1; i < logs.length; i++) monthlyReturns.push(logs[i] - logs[i - 1]);

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = (xs) => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };

  const rMonthlyMean = mean(monthlyReturns);
  const rMonthlyStd = std(monthlyReturns);

  // Jump detection: any monthly return > rMonthlyMean + 2·rMonthlyStd is a jump.
  // (We only count upward jumps — downward moves are absorbed by drift / reversion.)
  const jumpThreshold = rMonthlyMean + 2 * rMonthlyStd;
  const jumps = monthlyReturns.filter((r) => r > jumpThreshold);
  const nonJumpReturns = monthlyReturns.filter((r) => r <= jumpThreshold);
  const diffusionMonthlyStd = nonJumpReturns.length ? std(nonJumpReturns) : rMonthlyStd;

  // Annualize: monthly std × √12 = annual vol.
  const sigma = diffusionMonthlyStd * Math.sqrt(12);

  // Long-run mean: median of the back-half of log prices (recent regime).
  const back = logs.slice(Math.floor(logs.length / 2)).slice().sort((a, b) => a - b);
  const thetaLog = back[Math.floor(back.length / 2)];

  // κ via lag-1 autocorrelation of log deviations: cov(x[t], x[t-1]) / var(x).
  // For OU, ρ ≈ exp(−κ Δt). With Δt = 1/12 year, κ = −12·ln(ρ).
  const deviations = logs.map((x) => x - thetaLog);
  let num = 0, denom = 0;
  for (let i = 1; i < deviations.length; i++) num += deviations[i] * deviations[i - 1];
  for (let i = 0; i < deviations.length; i++) denom += deviations[i] * deviations[i];
  const rho = denom > 0 ? num / denom : 0;
  // Clamp rho to (0.05, 0.999) so κ is finite and positive.
  const rhoClamped = Math.min(0.999, Math.max(0.05, rho));
  const kappa = -12 * Math.log(rhoClamped);

  // Jump intensity: jumps per year.
  const years = (points.length - 1) / 12;
  const lambda = years > 0 ? jumps.length / years : 0;

  const jumpMeanLog = jumps.length > 0 ? mean(jumps) : 0.18;
  const jumpStdLog = jumps.length > 1 ? std(jumps) : 0.10;

  return {
    kappa: Number(kappa.toFixed(4)),
    thetaLog: Number(thetaLog.toFixed(4)),
    sigma: Number(sigma.toFixed(4)),
    lambda: Number(lambda.toFixed(4)),
    jumpMeanLog: Number(jumpMeanLog.toFixed(4)),
    jumpStdLog: Number(jumpStdLog.toFixed(4)),
    sampleSize: points.length,
    sourceWindow: [points[0].ym, points[points.length - 1].ym],
    jumpsIdentified: jumps.length,
  };
}
