import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrate, H100_MONTHLY } from '../src/pricing/calibration.js';

test('calibrate returns sensible jump-diffusion parameters on the bundled dataset', () => {
  const p = calibrate();
  // Sanity ranges — orders of magnitude for ~3-year H100 history.
  assert.ok(p.kappa > 0 && p.kappa < 30, `kappa out of range: ${p.kappa}`);
  assert.ok(p.sigma > 0 && p.sigma < 3, `sigma out of range: ${p.sigma}`);
  assert.ok(p.lambda >= 0 && p.lambda <= 12, `lambda out of range: ${p.lambda}`);
  assert.ok(p.thetaLog > Math.log(0.5) && p.thetaLog < Math.log(20), `thetaLog out of range: ${p.thetaLog}`);
  assert.equal(p.sampleSize, H100_MONTHLY.length);
  assert.deepEqual(p.sourceWindow, [H100_MONTHLY[0].ym, H100_MONTHLY[H100_MONTHLY.length - 1].ym]);
});

test('calibrate identifies the known shock months as jumps', () => {
  const p = calibrate();
  assert.ok(p.jumpsIdentified >= 1, `should pick up at least the 2023 shortage shock; got ${p.jumpsIdentified}`);
});

test('calibrate requires at least 6 points', () => {
  assert.throws(() => calibrate([{ ym: '2024-01', usdHr: 2 }]));
});

test('long-run mean θ falls inside the observed price range', () => {
  const p = calibrate();
  const prices = H100_MONTHLY.map((x) => x.usdHr);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const theta = Math.exp(p.thetaLog);
  assert.ok(theta >= lo * 0.6 && theta <= hi * 1.4, `θ=${theta.toFixed(2)} should be near the historical range [${lo}, ${hi}]`);
});
