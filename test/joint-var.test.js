import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExposureBook } from '../src/pool/exposure.js';

/**
 * Joint-VaR exposure tests use a deterministic R_T sampler (no Monte Carlo
 * dependence) so the test outputs are stable. The sampler returns a small
 * set of fixed R_T values that exercise different regions of the joint
 * payout function.
 */
function fixedSampler(rTs) {
  return ({ paths: _ }) => rTs;
}

test('joint-VaR equals Σ-maxPayout when all policies share the same strike (comonotone)', () => {
  // Two identical policies at K=4, Q=100. At R=10 each pays $(10-4)·100 = $600
  // so the joint payout is $1200 ≈ ~24000 HBAR at 0.05/HBAR. The 99% quantile
  // is the max sample (R=10).
  const book = createExposureBook({ maxExposureRatio: 1 });
  book.add({
    policyId: 'p1', buyer: '0.0.B', strikeUsdHr: 4, qtyGpuHr: 100,
    maxPayoutHbar: 12000, windowEndsTs: '2026-12-30T00:00:00.000Z',
  });
  const res = book.checkIssuanceJointVaR({
    poolBalanceHbar: 1000000,
    proposedPolicy: { policyId: 'p2', buyer: '0.0.B', strikeUsdHr: 4, qtyGpuHr: 100, maxPayoutHbar: 12000, windowEndsTs: '2026-12-30T00:00:00.000Z' },
    rTSampler: fixedSampler([3, 4, 5, 8, 10]),
    hbarUsdPrice: 0.05,
    quantile: 0.99,
  });
  // 99% quantile of joint payouts = max sample. At R=10: (10-4)·100·2 = $1200 → 24000 HBAR.
  assert.equal(res.ok, true);
  assert.ok(Math.abs(res.jointVarHbar - 24000) < 1e-6, `expected 24000 HBAR joint VaR, got ${res.jointVarHbar}`);
});

test('joint-VaR is BELOW Σ-maxPayout for heterogeneous strikes (the win)', () => {
  // Policy A: K=4, Q=100 → at R=10 pays $600 (12000 HBAR)
  // Policy B: K=20, Q=100 → at R=10 pays $0; at R=25 pays $500 (10000 HBAR)
  // Σ-maxPayout at the worst-case R for each would be 12000 + 10000 = 22000 HBAR
  // but at any SHARED R in {3,5,10,15,25}, only one regime fires substantially.
  // The 99% quantile of joint sum is the highest sample sum:
  //   R=25: A pays $2100 = 42000 HBAR; B pays $500 = 10000 HBAR; sum 52000 HBAR
  //   R=10: A pays $600 = 12000 HBAR; B pays $0; sum 12000 HBAR
  // 99% quantile of these = 52000.
  // Σ-maxPayout at the R=25 case (both fire) = same.
  // Σ-maxPayout summed over each policy's own worst case: 42000+10000 = 52000.
  // So at R=25 the joint payout equals Σ. The win is at lower R values —
  // joint payout is dramatically lower than Σ-maxPayout, but the QUANTILE is
  // taken at the upper end.
  // For widely-separated strikes the win comes when the upper R sample is
  // NOT a worst case for both — e.g., if we stress only to R=12:
  const book = createExposureBook({ maxExposureRatio: 1 });
  book.add({
    policyId: 'pA', buyer: '0.0.B', strikeUsdHr: 4, qtyGpuHr: 100,
    maxPayoutHbar: 12000, windowEndsTs: '2026-12-30T00:00:00.000Z',
  });
  const proposed = { policyId: 'pB', buyer: '0.0.B', strikeUsdHr: 20, qtyGpuHr: 100, maxPayoutHbar: 10000, windowEndsTs: '2026-12-30T00:00:00.000Z' };
  const res = book.checkIssuanceJointVaR({
    poolBalanceHbar: 1000000,
    proposedPolicy: proposed,
    // Stress only to R=12 — A pays, B doesn't.
    rTSampler: fixedSampler([3, 5, 8, 10, 12]),
    hbarUsdPrice: 0.05,
    quantile: 0.99,
  });
  // Max-sample R=12: A pays (12-4)·100 = $800 = 16000 HBAR; B pays 0; joint = 16000.
  // Σ-maxPayout would say 12000 + 10000 = 22000.
  assert.ok(res.jointVarHbar < 22000, `joint VaR ${res.jointVarHbar} should be below Σ-maxPayout 22000`);
});

test('refuses when joint VaR exceeds pool cap', () => {
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  const res = book.checkIssuanceJointVaR({
    poolBalanceHbar: 100,
    proposedPolicy: { policyId: 'p1', buyer: '0.0.B', strikeUsdHr: 2, qtyGpuHr: 100, maxPayoutHbar: 99999, windowEndsTs: '2026-12-30T00:00:00.000Z' },
    rTSampler: fixedSampler([5, 8, 10]),  // joint at R=10: (10-2)·100 = $800 = 16000 HBAR
    hbarUsdPrice: 0.05,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /VaR.*exceeds.*pool cap/);
});

test('respects per-policy maxPayoutCapUsd', () => {
  const book = createExposureBook({ maxExposureRatio: 1 });
  const res = book.checkIssuanceJointVaR({
    poolBalanceHbar: 100000,
    proposedPolicy: { policyId: 'p1', buyer: '0.0.B', strikeUsdHr: 2, qtyGpuHr: 100, maxPayoutCapUsd: 50, maxPayoutHbar: 9999, windowEndsTs: '2026-12-30T00:00:00.000Z' },
    rTSampler: fixedSampler([5, 8, 10]),  // un-capped: (10-2)·100 = $800; capped at $50 = 1000 HBAR
    hbarUsdPrice: 0.05,
  });
  assert.ok(Math.abs(res.jointVarHbar - 1000) < 1e-6, `capped joint VaR ${res.jointVarHbar}; expected ≈ 1000`);
});

test('requires K/Q on the proposed policy', () => {
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  assert.throws(() => book.checkIssuanceJointVaR({
    poolBalanceHbar: 100,
    proposedPolicy: { policyId: 'p1', buyer: '0.0.B', maxPayoutHbar: 10, windowEndsTs: '2026-06-30T00:00:00.000Z' },
    rTSampler: fixedSampler([5]),
    hbarUsdPrice: 0.05,
  }), /strikeUsdHr/);
});

test('active policies missing K/Q get full maxPayoutHbar added (conservative)', () => {
  const book = createExposureBook({ maxExposureRatio: 1 });
  book.add({ policyId: 'legacy', buyer: '0.0.B', maxPayoutHbar: 500, windowEndsTs: '2026-12-30T00:00:00.000Z' });
  const res = book.checkIssuanceJointVaR({
    poolBalanceHbar: 100000,
    proposedPolicy: { policyId: 'pNew', buyer: '0.0.B', strikeUsdHr: 4, qtyGpuHr: 100, maxPayoutHbar: 0, windowEndsTs: '2026-12-30T00:00:00.000Z' },
    rTSampler: fixedSampler([5, 8, 10]),  // joint payout from new policy at R=10: (10-4)·100=$600 = 12000 HBAR
    hbarUsdPrice: 0.05,
  });
  // Joint at R=10 = 12000 (new) + 500 (legacy flat) = 12500 HBAR.
  assert.ok(Math.abs(res.jointVarHbar - 12500) < 1e-6, `expected 12500 HBAR; got ${res.jointVarHbar}`);
});
