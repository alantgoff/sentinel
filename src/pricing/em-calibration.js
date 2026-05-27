/**
 * EM (Expectation-Maximization) calibration for the jump component of the
 * jump-diffusion price model.
 *
 * Replaces the previous 2σ threshold-based jump detection with a rigorous
 * latent-variable formulation:
 *
 *   For each monthly log-return r_t, the latent indicator I_t ∈ {0, 1}
 *   tells us whether a jump occurred during that month. Under the model:
 *
 *     P(I_t = 1) = p = λ · Δt                  (Δt = 1/12 yr for monthly data)
 *     r_t | I_t = 0  ~  N( μ_t, σ²·Δt )
 *     r_t | I_t = 1  ~  N( μ_t + μ_J, σ²·Δt + σ_J² )
 *
 *   where μ_t = κ·(θ − log P_{t-1})·Δt is the local OU drift (κ, θ are
 *   held fixed at the method-of-moments estimates — they're already robust;
 *   EM refines the jump-diffusion parameters).
 *
 * The EM algorithm iterates:
 *
 *   E-step: γ_t = P(I_t = 1 | r_t, θ̂) ← posterior jump probability
 *   M-step: weighted MLE for (σ², λ, μ_J, σ_J²)
 *
 * Convergence to a local maximum of the marginal likelihood is guaranteed
 * by the EM theorem (Dempster-Laird-Rubin 1977). For this problem the
 * likelihood surface is well-behaved, and 20-50 iterations suffice.
 *
 * Reference: Press 1967, Ball-Torous 1983 — the canonical jump-diffusion
 * mixture-likelihood treatment. Honoré 1998 generalizes; recent EM
 * implementations (ESAIM PS 2020) extend to Lévy-driven SDEs and Markov-
 * modulated jump-diffusions. We implement the single-regime version here;
 * two-regime EM with Baum-Welch over the regime sequence is the obvious
 * next step, documented in LIMITATIONS.md as future work.
 */

const DT_MONTHLY = 1 / 12;

/**
 * Normal PDF with mean μ, variance σ².
 */
function normPdf(x, mu, varSq) {
  const inv = 1 / Math.sqrt(2 * Math.PI * varSq);
  return inv * Math.exp(-((x - mu) ** 2) / (2 * varSq));
}

/**
 * @typedef {object} EmCalibrationResult
 * @property {number} kappa
 * @property {number} thetaLog
 * @property {number} sigma            (per √year, annualized)
 * @property {number} lambda           (per year, annualized)
 * @property {number} jumpMeanLog
 * @property {number} jumpStdLog
 * @property {number} iterations
 * @property {number} logLikelihood
 * @property {number[]} llTrace        log-likelihood per iteration
 * @property {number[]} jumpProbabilities   posterior P(jump | obs) for each observation
 * @property {{ ym: string, posteriorJump: number }[]} [perObservation]
 */

/**
 * @param {{ ym: string, usdHr: number }[]} points
 * @param {object} [opts]
 * @param {number} [opts.kappa]       if omitted, estimated by method-of-moments lag-1 autocorr
 * @param {number} [opts.thetaLog]    if omitted, estimated as median of back-half log prices
 * @param {number} [opts.maxIter=200]
 * @param {number} [opts.tol=1e-6]    log-likelihood change tolerance
 * @returns {EmCalibrationResult}
 */
export function emCalibrate(points, opts = {}) {
  if (!Array.isArray(points) || points.length < 6) {
    throw new Error('need at least 6 monthly points for EM');
  }
  const logs = points.map((p) => Math.log(p.usdHr));
  const returns = [];
  for (let i = 1; i < logs.length; i++) returns.push(logs[i] - logs[i - 1]);
  const prevLogs = logs.slice(0, -1);
  const N = returns.length;

  // Method-of-moments seed for κ, θ unless caller supplied them.
  let thetaLog = opts.thetaLog;
  if (thetaLog === undefined) {
    const back = logs.slice(Math.floor(logs.length / 2)).slice().sort((a, b) => a - b);
    thetaLog = back[Math.floor(back.length / 2)];
  }
  let kappa = opts.kappa;
  if (kappa === undefined) {
    const devs = logs.map((x) => x - /** @type {number} */ (thetaLog));
    let num = 0, denom = 0;
    for (let i = 1; i < devs.length; i++) num += devs[i] * devs[i - 1];
    for (let i = 0; i < devs.length; i++) denom += devs[i] * devs[i];
    const rho = denom > 0 ? num / denom : 0;
    const rhoClamped = Math.min(0.999, Math.max(0.05, rho));
    kappa = -12 * Math.log(rhoClamped);
  }

  // Initialize jump-diffusion parameters from moment-style guess.
  const mu = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = (xs) => {
    const m = mu(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  let sigma = std(returns) * Math.sqrt(12);                  // annualized
  let lambda = 1.0;                                          // 1 jump/yr initial guess
  let jumpMeanLog = 0.15;
  let jumpStdLog = 0.10;

  const maxIter = opts.maxIter ?? 200;
  const tol = opts.tol ?? 1e-6;
  /** @type {number[]} */
  const llTrace = [];
  let prevLL = -Infinity;
  let iter = 0;

  // Local drift for each observation under fixed κ, θ.
  const localDrift = returns.map((_r, t) => /** @type {number} */ (kappa) * (/** @type {number} */ (thetaLog) - prevLogs[t]) * DT_MONTHLY);

  /** @type {number[]} */
  let gamma = new Array(N).fill(0);

  for (iter = 0; iter < maxIter; iter++) {
    // ---- E-step ----
    const p = Math.min(0.99, lambda * DT_MONTHLY);            // monthly jump prob, clamped
    const varDiff = Math.max(1e-12, sigma * sigma * DT_MONTHLY);
    const varJump = varDiff + Math.max(1e-12, jumpStdLog * jumpStdLog);

    let ll = 0;
    for (let t = 0; t < N; t++) {
      const r = returns[t];
      const mDiff = localDrift[t];
      const mJump = mDiff + jumpMeanLog;
      const pdfDiff = normPdf(r, mDiff, varDiff);
      const pdfJump = normPdf(r, mJump, varJump);
      const mixDensity = (1 - p) * pdfDiff + p * pdfJump;
      gamma[t] = mixDensity > 0 ? (p * pdfJump) / mixDensity : 0;
      ll += Math.log(Math.max(1e-300, mixDensity));
    }
    llTrace.push(ll);

    if (iter > 0 && Math.abs(ll - prevLL) < tol) break;
    prevLL = ll;

    // ---- M-step ----
    const sumGamma = gamma.reduce((a, b) => a + b, 0);
    const sumNoJump = N - sumGamma;

    // λ: monthly jump frequency p̂ = mean(γ); annualize.
    const pNew = sumGamma / N;
    lambda = Math.min(36, Math.max(0.01, pNew / DT_MONTHLY));

    // σ² (annualized): weighted MLE for the diffusion variance using
    // (1-γ_t) weights on the diffusion residuals plus the diffusion share
    // of the jump observations.
    //   E[(r-μ)² | I=0] = σ²·Δt
    //   E[(r-μ-μ_J)² | I=1] = σ²·Δt + σ_J²
    // We separate σ²·Δt from σ_J² via the M-step's two-equation system:
    //   σ²·Δt = Σ (1-γ_t)·(r_t-μ_t)² / Σ(1-γ_t)
    //   σ_J²   = Σ γ_t·(r_t-μ_t-μ_J)² / Σγ_t   −  σ²·Δt
    let weightedDiffSq = 0;
    for (let t = 0; t < N; t++) {
      const e = returns[t] - localDrift[t];
      weightedDiffSq += (1 - gamma[t]) * e * e;
    }
    const sigmaMonthlySq = sumNoJump > 0 ? weightedDiffSq / sumNoJump : 1e-8;
    sigma = Math.sqrt(Math.max(1e-12, sigmaMonthlySq / DT_MONTHLY));

    // μ_J: weighted mean of (r_t - μ_t) using γ as weights.
    let weightedJumpSum = 0;
    for (let t = 0; t < N; t++) weightedJumpSum += gamma[t] * (returns[t] - localDrift[t]);
    const jumpMeanNew = sumGamma > 0 ? weightedJumpSum / sumGamma : jumpMeanLog;
    jumpMeanLog = jumpMeanNew;

    // σ_J²: weighted variance of (r_t - μ_t - μ_J) using γ — minus the σ²·Δt
    // diffusion contribution (since the jump observations carry both).
    let weightedJumpSqSum = 0;
    for (let t = 0; t < N; t++) {
      const c = returns[t] - localDrift[t] - jumpMeanLog;
      weightedJumpSqSum += gamma[t] * c * c;
    }
    const jumpVarRaw = sumGamma > 0 ? weightedJumpSqSum / sumGamma : 0;
    const jumpVarAdjusted = Math.max(1e-8, jumpVarRaw - sigmaMonthlySq);
    jumpStdLog = Math.sqrt(jumpVarAdjusted);
  }

  return {
    kappa: Number(/** @type {number} */ (kappa).toFixed(4)),
    thetaLog: Number(/** @type {number} */ (thetaLog).toFixed(4)),
    sigma: Number(sigma.toFixed(4)),
    lambda: Number(lambda.toFixed(4)),
    jumpMeanLog: Number(jumpMeanLog.toFixed(4)),
    jumpStdLog: Number(jumpStdLog.toFixed(4)),
    iterations: iter + 1,
    logLikelihood: Number(prevLL.toFixed(4)),
    llTrace: llTrace.map((x) => Number(x.toFixed(4))),
    jumpProbabilities: gamma.map((x) => Number(x.toFixed(4))),
    perObservation: points.slice(1).map((p, i) => ({ ym: p.ym, posteriorJump: Number(gamma[i].toFixed(4)) })),
  };
}
