import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules } from '../src/plugin/rules.js';
import { RULE_IDS } from '../src/plugin/types.js';

const BASE_POLICY = {
  autonomousCapHbar: 2,
  dailyLimitHbar: 20,
  velocityWindowSeconds: 300,
  velocityMaxTxns: 5,
};

const NOW = '2026-05-26T15:00:00.000Z';

function settlement(ts, amountHbar, seller = '0.0.2002', buyer = '0.0.1001') {
  return {
    buyer,
    seller,
    service: 'funding-round-lookup',
    amountHbar,
    ts,
    txId: `0.0.1001@${Math.floor(new Date(ts).getTime() / 1000)}.0`,
    verified: true,
  };
}

const REQ = {
  buyer: '0.0.1001',
  seller: '0.0.2002',
  service: 'funding-round-lookup',
  amountHbar: 1,
};

test('clean ALLOW within all limits', () => {
  const r = evaluateRules(REQ, { policy: BASE_POLICY, now: NOW });
  assert.equal(r.decision, 'ALLOW');
  assert.equal(r.ruleId, RULE_IDS.CLEAN);
});

test('denylisted seller → DENY', () => {
  const r = evaluateRules(REQ, {
    policy: { ...BASE_POLICY, counterpartyDenylist: ['0.0.2002'] },
    now: NOW,
  });
  assert.equal(r.decision, 'DENY');
  assert.equal(r.ruleId, RULE_IDS.DENYLIST);
});

test('service not on allowlist → DENY', () => {
  const r = evaluateRules(REQ, {
    policy: { ...BASE_POLICY, serviceAllowlist: ['weather-lookup'] },
    now: NOW,
  });
  assert.equal(r.decision, 'DENY');
  assert.equal(r.ruleId, RULE_IDS.ALLOWLIST);
});

test('amount above hard cap → DENY (refuses even ESCALATE)', () => {
  const r = evaluateRules({ ...REQ, amountHbar: 999 }, { policy: BASE_POLICY, now: NOW });
  assert.equal(r.decision, 'DENY');
  assert.equal(r.ruleId, RULE_IDS.HARD_CAP);
});

test('amount above autonomous cap but under hard cap → ESCALATE', () => {
  const r = evaluateRules({ ...REQ, amountHbar: 5 }, { policy: BASE_POLICY, now: NOW });
  assert.equal(r.decision, 'ESCALATE');
  assert.equal(r.ruleId, RULE_IDS.AUTONOMOUS_CAP);
});

test('daily limit triggers ESCALATE before autonomous cap', () => {
  const recent = [
    settlement('2026-05-26T01:00:00.000Z', 18),
    settlement('2026-05-26T02:00:00.000Z', 1),
  ];
  // 18+1 = 19 today, + req 1.5 = 20.5 > 20 daily.
  // Amount 1.5 is below autonomous cap (2), so the only firing rule is daily.
  const r = evaluateRules({ ...REQ, amountHbar: 1.5 }, {
    policy: BASE_POLICY,
    recentSettlements: recent,
    now: NOW,
  });
  assert.equal(r.decision, 'ESCALATE');
  assert.equal(r.ruleId, RULE_IDS.DAILY_LIMIT);
});

test('daily limit only counts settlements from the current UTC day', () => {
  const recent = [settlement('2026-05-25T23:00:00.000Z', 18)]; // yesterday
  const r = evaluateRules({ ...REQ, amountHbar: 1.5 }, {
    policy: BASE_POLICY,
    recentSettlements: recent,
    now: NOW,
  });
  assert.equal(r.decision, 'ALLOW');
});

test('velocity limit triggers ESCALATE', () => {
  // 5 settlements in the last 300s — one more would be #6.
  const recent = Array.from({ length: 5 }, (_, i) =>
    settlement(`2026-05-26T14:59:${String(50 - i).padStart(2, '0')}.000Z`, 0.1),
  );
  const r = evaluateRules(REQ, {
    policy: BASE_POLICY,
    recentSettlements: recent,
    now: NOW,
  });
  assert.equal(r.decision, 'ESCALATE');
  assert.equal(r.ruleId, RULE_IDS.VELOCITY);
});

test('order: DENY before ESCALATE — hard cap beats velocity', () => {
  const recent = Array.from({ length: 10 }, (_, i) =>
    settlement(`2026-05-26T14:59:${String(50 - i).padStart(2, '0')}.000Z`, 0.1),
  );
  const r = evaluateRules({ ...REQ, amountHbar: 999 }, {
    policy: BASE_POLICY,
    recentSettlements: recent,
    now: NOW,
  });
  assert.equal(r.decision, 'DENY');
  assert.equal(r.ruleId, RULE_IDS.HARD_CAP);
});

test('order: denylist beats hard cap', () => {
  const r = evaluateRules({ ...REQ, amountHbar: 999 }, {
    policy: { ...BASE_POLICY, counterpartyDenylist: ['0.0.2002'] },
    now: NOW,
  });
  assert.equal(r.decision, 'DENY');
  assert.equal(r.ruleId, RULE_IDS.DENYLIST);
});

test('hardCap defaults to autonomousCap × 5', () => {
  // autonomousCap=2 → hardCap=10. amount=10 should ESCALATE, not DENY.
  const r = evaluateRules({ ...REQ, amountHbar: 10 }, { policy: BASE_POLICY, now: NOW });
  assert.equal(r.decision, 'ESCALATE');
  assert.equal(r.ruleId, RULE_IDS.AUTONOMOUS_CAP);
  // amount=10.01 trips hard cap
  const r2 = evaluateRules({ ...REQ, amountHbar: 10.01 }, { policy: BASE_POLICY, now: NOW });
  assert.equal(r2.decision, 'DENY');
  assert.equal(r2.ruleId, RULE_IDS.HARD_CAP);
});

test('amount exactly at autonomous cap → ALLOW (boundary)', () => {
  const r = evaluateRules({ ...REQ, amountHbar: 2 }, { policy: BASE_POLICY, now: NOW });
  assert.equal(r.decision, 'ALLOW');
});
