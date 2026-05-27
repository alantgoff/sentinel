import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulatePath, injectShock, pathStats, DEFAULT_PARAMS } from '../src/pricing/price-model.js';
import { createRng } from '../src/pricing/rng.js';

test('simulatePath returns days+1 points starting at R0', () => {
  const path = simulatePath({ R0: 2.5, days: 30, rng: createRng(42) });
  assert.equal(path.length, 31);
  assert.equal(path[0], 2.5);
});

test('all prices strictly positive', () => {
  const path = simulatePath({ R0: 2.5, days: 365, rng: createRng(42) });
  for (let i = 0; i < path.length; i++) assert.ok(path[i] > 0, `path[${i}] = ${path[i]}`);
});

test('seed gives deterministic path', () => {
  const a = simulatePath({ R0: 2.5, days: 60, rng: createRng(123) });
  const b = simulatePath({ R0: 2.5, days: 60, rng: createRng(123) });
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
});

test('different seeds give different paths', () => {
  const a = simulatePath({ R0: 2.5, days: 60, rng: createRng(1) });
  const b = simulatePath({ R0: 2.5, days: 60, rng: createRng(2) });
  let diffs = 0;
  for (let i = 1; i < a.length; i++) if (a[i] !== b[i]) diffs++;
  assert.ok(diffs > 50, `expected substantial divergence, got ${diffs} differences`);
});

test('OU mean reversion: pure (no-jump) process pulls log R toward θ', () => {
  // With jumps off, the model is pure OU on log price. E[log R_∞] = θ exactly,
  // independent of variance — which is the cleanest statement of mean reversion
  // and the right thing to test. (With jumps on, the long-run mean of log R
  // shifts to θ + λ·μ_J/κ; testing R directly conflates drift with the lognormal
  // variance correction. We test that explicitly elsewhere by varying λ.)
  const params = { ...DEFAULT_PARAMS, lambda: 0 };
  const samples = [];
  for (let s = 0; s < 80; s++) {
    const path = simulatePath({ R0: 5.0, days: 1500, params, rng: createRng(1000 + s) });
    let sumLog = 0, n = 0;
    for (let i = 400; i < path.length; i++) { sumLog += Math.log(path[i]); n++; }
    samples.push(sumLog / n);
  }
  const ensembleLogMean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(
    Math.abs(ensembleLogMean - DEFAULT_PARAMS.thetaLog) < 0.1,
    `ensemble log-mean ${ensembleLogMean.toFixed(3)} not within 0.1 of θ ${DEFAULT_PARAMS.thetaLog.toFixed(3)}`,
  );
});

test('jumps shift the long-run mean upward (right-tail mass)', () => {
  // Holding everything else fixed, turning jumps on raises E[R_∞] because
  // upward jumps with mean log size > 0 add positive drift to log R, which
  // mean reversion absorbs only partially.
  function ensembleMean(lambda) {
    const params = { ...DEFAULT_PARAMS, lambda };
    let total = 0, count = 0;
    for (let s = 0; s < 40; s++) {
      const path = simulatePath({ R0: 5.0, days: 1500, params, rng: createRng(2000 + s) });
      for (let i = 400; i < path.length; i++) { total += path[i]; count++; }
    }
    return total / count;
  }
  const noJumps = ensembleMean(0);
  const withJumps = ensembleMean(6);
  assert.ok(withJumps > noJumps * 1.2, `with-jumps ${withJumps.toFixed(2)} should noticeably exceed no-jumps ${noJumps.toFixed(2)}`);
});

test('higher diffusion vol → higher dispersion at fixed horizon', () => {
  function disp(sigma) {
    const ends = [];
    for (let s = 0; s < 200; s++) {
      const path = simulatePath({
        R0: 2.5, days: 30,
        params: { ...DEFAULT_PARAMS, sigma, lambda: 0 }, // no jumps for a clean test
        rng: createRng(7000 + s),
      });
      ends.push(path[30]);
    }
    const m = ends.reduce((a, b) => a + b, 0) / ends.length;
    return Math.sqrt(ends.reduce((a, b) => a + (b - m) ** 2, 0) / ends.length);
  }
  const lo = disp(0.20);
  const hi = disp(0.80);
  assert.ok(hi > lo * 1.5, `expected hi-vol dispersion ${hi.toFixed(3)} >> lo-vol ${lo.toFixed(3)}`);
});

test('higher jump intensity → more right-tail mass at fixed horizon', () => {
  function frac(lambda) {
    const ends = [];
    for (let s = 0; s < 400; s++) {
      const path = simulatePath({
        R0: 2.5, days: 60,
        params: { ...DEFAULT_PARAMS, sigma: 0.1, lambda, jumpMeanLog: 0.4, jumpStdLog: 0.05 },
        rng: createRng(8000 + s),
      });
      ends.push(path[60]);
    }
    const above = ends.filter((x) => x > 3.5).length;
    return above / ends.length;
  }
  const lo = frac(0);
  const hi = frac(20);
  assert.ok(hi > lo + 0.05, `expected more high-tail with jumps: lo=${lo}, hi=${hi}`);
});

test('injectShock applies multiplicative bump from dayIndex forward', () => {
  const path = simulatePath({ R0: 2.5, days: 10, rng: createRng(42) });
  const before5 = path[5];
  const before9 = path[9];
  injectShock(path, 5, 1.6);
  assert.ok(Math.abs(path[5] - before5 * 1.6) < 1e-9);
  assert.ok(Math.abs(path[9] - before9 * 1.6) < 1e-9);
});

test('injectShock bounds-checks', () => {
  const path = simulatePath({ R0: 2.5, days: 5, rng: createRng(1) });
  assert.throws(() => injectShock(path, -1, 1.5), /dayIndex/);
  assert.throws(() => injectShock(path, 999, 1.5), /dayIndex/);
  assert.throws(() => injectShock(path, 2, 0), /magnitude/);
  assert.throws(() => injectShock(path, 2, -1), /magnitude/);
});

test('pathStats returns sensible values', () => {
  const path = new Float64Array([1, 2, 3, 4, 5]);
  const s = pathStats(path);
  assert.equal(s.min, 1);
  assert.equal(s.max, 5);
  assert.equal(s.mean, 3);
  assert.equal(s.last, 5);
});

test('simulatePath validates inputs', () => {
  assert.throws(() => simulatePath({ R0: 0, days: 10 }), /R0/);
  assert.throws(() => simulatePath({ R0: -1, days: 10 }), /R0/);
  assert.throws(() => simulatePath({ R0: 2.5, days: -1 }), /days/);
  assert.throws(() => simulatePath({ R0: 2.5, days: 1.5 }), /days/);
});
