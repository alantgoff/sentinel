import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emCalibrate } from '../src/pricing/em-calibration.js';
import { H100_MONTHLY } from '../src/pricing/calibration.js';

test('emCalibrate returns sane parameter ranges on the bundled H100 data', () => {
  const r = emCalibrate(H100_MONTHLY);
  assert.ok(r.kappa > 0 && r.kappa < 30, `kappa out of range: ${r.kappa}`);
  assert.ok(r.sigma > 0 && r.sigma < 5, `sigma out of range: ${r.sigma}`);
  assert.ok(r.lambda > 0 && r.lambda < 36, `lambda out of range: ${r.lambda}`);
  assert.ok(r.jumpStdLog > 0, 'jumpStdLog must be positive');
  assert.ok(Array.isArray(r.jumpProbabilities) && r.jumpProbabilities.length === H100_MONTHLY.length - 1);
});

test('emCalibrate produces a non-decreasing log-likelihood trace (EM property)', () => {
  const r = emCalibrate(H100_MONTHLY, { maxIter: 50 });
  // Strict non-decrease modulo numerical noise; EM guarantees monotonic LL.
  for (let i = 1; i < r.llTrace.length; i++) {
    assert.ok(r.llTrace[i] >= r.llTrace[i - 1] - 1e-3,
      `LL decreased at iter ${i}: ${r.llTrace[i - 1]} → ${r.llTrace[i]}`);
  }
});

test('emCalibrate assigns highest posterior jump probability to known shock months', () => {
  const r = emCalibrate(H100_MONTHLY);
  // The bundled data has explicit "shortage onset" / "Llama 3 launch squeeze" annotations.
  // We check that those months land in the top quartile of posterior jump probabilities.
  const sorted = r.perObservation.slice().sort((a, b) => b.posteriorJump - a.posteriorJump);
  const topQuartile = sorted.slice(0, Math.ceil(sorted.length / 4)).map((x) => x.ym);
  // The annotated shock months in the data:
  const knownShocks = ['2023-07', '2023-08', '2024-04'];
  let hits = 0;
  for (const ym of knownShocks) if (topQuartile.includes(ym)) hits++;
  assert.ok(hits >= 2, `expected ≥ 2 known shocks in the top-quartile posterior; got ${hits}: ${topQuartile.join(', ')}`);
});

test('emCalibrate converges quickly (≤ 50 iterations for typical data)', () => {
  const r = emCalibrate(H100_MONTHLY, { maxIter: 200, tol: 1e-6 });
  assert.ok(r.iterations <= 50, `EM took ${r.iterations} iters; expected < 50`);
});

test('emCalibrate respects user-supplied κ and θ', () => {
  const r = emCalibrate(H100_MONTHLY, { kappa: 0.5, thetaLog: 0.7 });
  assert.equal(r.kappa, 0.5);
  assert.equal(r.thetaLog, 0.7);
});

test('emCalibrate input validation', () => {
  assert.throws(() => emCalibrate([{ ym: '2024-01', usdHr: 2 }]));
});
