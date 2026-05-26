import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePolicy, effectiveLimits } from '../src/plugin/policy.js';
import { RULE_IDS } from '../src/plugin/types.js';

const BASE_POLICY = {
  autonomousCapHbar: 2,
  dailyLimitHbar: 20,
  velocityWindowSeconds: 300,
  velocityMaxTxns: 5,
};

const NOW = '2026-05-26T15:00:00.000Z';

const REQ = {
  buyer: '0.0.1001',
  seller: '0.0.2002',
  service: 'funding-round-lookup',
  amountHbar: 1,
};

/** @returns {import('../src/plugin/types.js').ReputationProfile} */
function rep({
  score = 70,
  verifiedSettlementCount = 5,
  totalSettlementClaims = 5,
  verifiedVolumeHbar = 10,
} = {}) {
  return {
    counterparty: '0.0.2002',
    score,
    verifiedSettlementCount,
    totalSettlementClaims,
    verifiedVolumeHbar,
    oldestVerifiedTs: '2026-05-20T00:00:00.000Z',
    newestVerifiedTs: '2026-05-26T14:00:00.000Z',
    denialCount: 0,
    claimToVerifiedRatio: totalSettlementClaims === 0 ? 1 : verifiedSettlementCount / totalSettlementClaims,
    reasons: [],
  };
}

test('thin history forces ESCALATE even at small amount', () => {
  const d = decidePolicy({
    request: { ...REQ, amountHbar: 0.5 },
    policy: BASE_POLICY,
    reputation: rep({ verifiedSettlementCount: 1, totalSettlementClaims: 1, score: 30 }),
    now: NOW,
  });
  assert.equal(d.decision, 'ESCALATE');
  assert.equal(d.ruleId, RULE_IDS.THIN_HISTORY);
});

test('poor verifiability forces DENY', () => {
  const d = decidePolicy({
    request: REQ,
    policy: BASE_POLICY,
    reputation: rep({
      verifiedSettlementCount: 1,
      totalSettlementClaims: 10,
      score: 5,
    }),
    now: NOW,
  });
  assert.equal(d.decision, 'DENY');
  assert.equal(d.ruleId, RULE_IDS.POOR_VERIFIABILITY);
});

test('high-rep counterparty gets a raised autonomous cap', () => {
  const limits = effectiveLimits(BASE_POLICY, rep({ score: 95 }));
  assert.equal(limits.multiplier, 2);
  assert.equal(limits.autonomousCapHbar, 4); // 2 * 2.0
  assert.equal(limits.dailyLimitHbar, 40);
});

test('low-rep counterparty gets a shrunken cap', () => {
  const limits = effectiveLimits(BASE_POLICY, rep({ score: 10 }));
  assert.equal(limits.multiplier, 0.5);
  assert.equal(limits.autonomousCapHbar, 1);
});

test('effective limits respect the hard cap', () => {
  // hardCap default = autonomousCap * 5 = 10. Multiplier 2.0 would push to 4, fine.
  // But if we set autonomousCapHbar high and rep high, hardCap still pins.
  const limits = effectiveLimits({ ...BASE_POLICY, autonomousCapHbar: 10 }, rep({ score: 95 }));
  // hardCap = 10 * 5 = 50, so 10 * 2 = 20 ≤ 50 — fine.
  assert.equal(limits.autonomousCapHbar, 20);
  // But with an explicit hardCap:
  const limits2 = effectiveLimits(
    { ...BASE_POLICY, autonomousCapHbar: 10, hardCapHbar: 15 },
    rep({ score: 95 }),
  );
  assert.equal(limits2.autonomousCapHbar, 15);
});

test('clean high-rep + small amount → ALLOW', () => {
  const d = decidePolicy({
    request: { ...REQ, amountHbar: 1 },
    policy: BASE_POLICY,
    reputation: rep({ score: 80, verifiedSettlementCount: 10, totalSettlementClaims: 10 }),
    now: NOW,
  });
  assert.equal(d.decision, 'ALLOW');
});

test('high rep raises cap so a normally-ESCALATE amount becomes ALLOW', () => {
  // autonomousCapHbar 2, but score 95 → effective cap 4. Amount 3 fits.
  const d = decidePolicy({
    request: { ...REQ, amountHbar: 3 },
    policy: BASE_POLICY,
    reputation: rep({ score: 95, verifiedSettlementCount: 10, totalSettlementClaims: 10 }),
    now: NOW,
  });
  assert.equal(d.decision, 'ALLOW');
});

test('hard cap still bites even with high rep', () => {
  const d = decidePolicy({
    request: { ...REQ, amountHbar: 999 },
    policy: BASE_POLICY,
    reputation: rep({ score: 95, verifiedSettlementCount: 100, totalSettlementClaims: 100 }),
    now: NOW,
  });
  assert.equal(d.decision, 'DENY');
  assert.equal(d.ruleId, RULE_IDS.HARD_CAP);
});

test('denial output carries the reputation profile and effective limits', () => {
  const d = decidePolicy({
    request: { ...REQ, amountHbar: 999 },
    policy: BASE_POLICY,
    reputation: rep({ verifiedSettlementCount: 5, totalSettlementClaims: 5 }),
    now: NOW,
  });
  assert.equal(d.decision, 'DENY');
  assert.equal(d.reputation.counterparty, '0.0.2002');
  assert.ok(d.effective.autonomousCapHbar > 0);
});
