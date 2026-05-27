import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTools, TOOL_NAMES } from '../src/plugin/tools.js';
import { createExposureBook } from '../src/pool/exposure.js';

/**
 * Plugin tools are exercised with a mock mirror (so we don't need testnet
 * and so we can script verifyTransaction / pool balance results) and a
 * fake "submit" hook that captures envelopes instead of sending to HCS.
 */
function build({
  poolBalanceHbar = 1000,
  verifyResult = null,
  R0 = 2.5,
}) {
  /** @type {any[]} */
  const submitted = [];
  // Mock client that captures submissions through hcs.js. We don't actually
  // hit the Hedera SDK; the kit's tool execute() will call submitEnvelope
  // which in turn calls client methods. We monkey-patch by replacing the
  // hcs module's exports... too fiddly. Instead, the kit submitEnvelope
  // function takes the client; we pass a fake client that the SDK will
  // refuse to use. So we route around hcs by monkey-patching the tools
  // module's submitEnvelope via the onSubmit hook + a stub client.
  //
  // Cleaner approach: we test by giving the buildTools a fake mirror that
  // resolves account/{id} for the pool balance AND a special-cased
  // submitEnvelope replacement. For test scope we just inject everything
  // through the `mirror` mock + `onSubmit` and use a no-op Hedera client.
  const mirror = {
    baseUrl: 'mock://',
    async getJson(path) {
      if (path.startsWith('/api/v1/accounts/')) {
        // The pool balance reader divides by 1e8.
        return { balance: { balance: Math.round(poolBalanceHbar * 1e8) } };
      }
      throw new Error(`mock mirror not configured for ${path}`);
    },
    async verifyTransaction(_txId) {
      return verifyResult ?? {
        verified: false,
        result: 'INVALID_TRANSACTION',
        consensusTimestamp: null,
        hbarTransfers: [],
        error: 'mock: not configured',
        normalizedTxId: _txId,
      };
    },
    async *streamTopicMessages() {},
  };
  const exposure = createExposureBook({ maxExposureRatio: 0.5 });
  const priceFeed = { getRT: () => R0, getSource: () => 'sim:labeled' };
  // Stub the client + force submit via onSubmit so we don't need a real SDK.
  // We monkey-patch by setting tools to use a fake submitter via the test
  // hook: buildTools' submitEnvelope is imported from hcs.js, which calls
  // client.execute(). To bypass cleanly we provide a sentinel client that
  // hcs.submitEnvelope can recognize... actually simpler: we test the
  // *internal logic* of issue/settle by calling the tool's execute with a
  // throwing client and asserting it fails AT submit, after our
  // verification + exposure checks pass. The pure-function side (QUOTE,
  // pool_status, etc.) doesn't need a client.
  return {
    submitted,
    exposure,
    mirror,
    priceFeed,
    tools: buildTools({
      mirror,
      topicId: '0.0.9999',
      underwriterAccountId: '0.0.UW',
      exposure,
      priceFeed,
      hbarUsdPrice: 0.05,
      paths: 500,
      onSubmit: (env) => submitted.push(env),
    }),
  };
}

function findTool(tools, method) {
  const t = tools.find((x) => x.method === method);
  if (!t) throw new Error(`tool not found: ${method}`);
  return t;
}

test('QUOTE: deterministic with a seed', async () => {
  const { tools } = build({});
  const tool = findTool(tools, TOOL_NAMES.QUOTE);
  const a = await tool.execute(null, null, { buyer: '0.0.B', strikeUsdHr: 4.0, qtyGpuHr: 1000, windowDays: 30, seed: 7 });
  const b = await tool.execute(null, null, { buyer: '0.0.B', strikeUsdHr: 4.0, qtyGpuHr: 1000, windowDays: 30, seed: 7 });
  assert.equal(a.premiumHbar, b.premiumHbar);
  assert.equal(a.maxPayoutHbar, b.maxPayoutHbar);
  assert.ok(a.R0 === 2.5);
});

test('QUOTE: includes the cost decomposition', async () => {
  const { tools } = build({});
  const tool = findTool(tools, TOOL_NAMES.QUOTE);
  const q = await tool.execute(null, null, { buyer: '0.0.B', strikeUsdHr: 4.0, qtyGpuHr: 1000, windowDays: 30, seed: 7 });
  assert.ok(q.premiumHbar > 0);
  assert.ok(q.expectedPayoutHbar >= 0);
  assert.ok(q.riskLoadHbar >= 0);
  assert.ok(q.opsLoadHbar >= 0);
  assert.equal(q.ci95Hbar.length, 2);
  assert.ok(q.probInTheMoney >= 0 && q.probInTheMoney <= 1);
  assert.ok(q.maxPayoutHbar > 0);
});

test('POOL_STATUS reads balance from mirror + reports headroom', async () => {
  const { tools } = build({ poolBalanceHbar: 1000 });
  const tool = findTool(tools, TOOL_NAMES.POOL_STATUS);
  const s = await tool.execute(null, null, {});
  assert.equal(s.poolBalanceHbar, 1000);
  assert.equal(s.maxExposureHbar, 500);
  assert.equal(s.currentExposureHbar, 0);
  assert.equal(s.headroomHbar, 500);
});

test('LIST_POLICIES initially empty; reflects exposure book after add', async () => {
  const { tools, exposure } = build({});
  exposure.add({ policyId: 'pol-1', buyer: '0.0.B', maxPayoutHbar: 10, windowEndsTs: '2026-06-30T00:00:00.000Z' });
  const list = await findTool(tools, TOOL_NAMES.LIST_POLICIES).execute(null, null, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].policyId, 'pol-1');
});

test('GET_PARAMS returns the active params + both calibration provenances', async () => {
  const { tools } = build({});
  const out = await findTool(tools, TOOL_NAMES.GET_PARAMS).execute(null, null, {});
  assert.ok(out.momCalibratedFromBundledData.sampleSize > 0);
  assert.ok(out.emCalibratedFromBundledData.iterations > 0);
  assert.ok(Array.isArray(out.emCalibratedFromBundledData.llTrace));
  assert.equal(out.feedSource, 'sim:labeled');
  assert.equal(out.currentRT, 2.5);
  assert.equal(out.hbarUsdPrice, 0.05);
});

test('ISSUE refuses with a clear error when the premium tx does not verify', async () => {
  const { tools } = build({
    verifyResult: {
      verified: false, result: 'INVALID_SIGNATURE', error: 'forged tx',
      consensusTimestamp: null, hbarTransfers: [], normalizedTxId: '0.0.B-1-1',
    },
  });
  const issue = findTool(tools, TOOL_NAMES.ISSUE);
  await assert.rejects(
    issue.execute({}, {}, {
      buyer: '0.0.B',
      strikeUsdHr: 4, qtyGpuHr: 100, windowDays: 30,
      premiumHbar: 5, premiumTxId: '0.0.B@1.1', maxPayoutHbar: 10,
    }),
    /premium tx not verified/,
  );
});

test('ISSUE refuses when proposed exposure would exceed pool cap', async () => {
  const { tools, exposure } = build({ poolBalanceHbar: 100 });
  exposure.add({ policyId: 'p0', buyer: '0.0.B', maxPayoutHbar: 40, windowEndsTs: '2026-12-30T00:00:00.000Z' });
  const issue = findTool(tools, TOOL_NAMES.ISSUE);
  // 100 × 0.5 = 50 max exposure; already at 40 → headroom 10.
  // Premium passes verification (mock).
  const tinybars = Math.round(5 * 1e8);
  const verifyResult = {
    verified: true, result: 'SUCCESS', consensusTimestamp: '1.1',
    normalizedTxId: '0.0.B-1-1', hbarTransfers: [
      { account: '0.0.802', amount: 50_000, isApproval: false },
      { account: '0.0.B',  amount: -tinybars - 50_000, isApproval: false },
      { account: '0.0.UW', amount: tinybars,  isApproval: false },
    ],
  };
  // Re-build with the success mirror. Pre-load an active policy with K/Q so
  // the joint-VaR check has K/Q to integrate.
  const { tools: tools2, exposure: exp2 } = build({ poolBalanceHbar: 100, verifyResult });
  exp2.add({
    policyId: 'p0', buyer: '0.0.B',
    strikeUsdHr: 3, qtyGpuHr: 1000,  // big notional → big joint exposure
    maxPayoutHbar: 40,
    windowEndsTs: '2026-12-30T00:00:00.000Z',
  });
  const issue2 = findTool(tools2, TOOL_NAMES.ISSUE);
  await assert.rejects(
    issue2.execute({}, {}, {
      buyer: '0.0.B',
      strikeUsdHr: 4, qtyGpuHr: 1000, windowDays: 30,
      premiumHbar: 5, premiumTxId: '0.0.B@1.1', maxPayoutHbar: 20,
    }),
    /joint-VaR exposure check failed/,
  );
});
