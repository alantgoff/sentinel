import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReputationProfile } from '../src/plugin/reputation.js';
import { encodeEnvelope } from '../src/hedera/envelope.js';

const BUYER = '0.0.1001';
const SELLER = '0.0.2002';
const TOPIC = '0.0.9999';

function b64(env) {
  return Buffer.from(encodeEnvelope(env), 'utf8').toString('base64');
}

function settlementEnv(amountHbar, txId, daysAgo = 1) {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    v: 1,
    type: 'SETTLEMENT',
    ts,
    buyer: BUYER,
    seller: SELLER,
    service: 'funding-round-lookup',
    amountHbar,
    txId,
  };
}

function settlementTransfers(amountHbar) {
  const tinybars = Math.round(amountHbar * 1e8);
  return [
    { account: '0.0.98', amount: 50_000, is_approval: false },
    { account: BUYER, amount: -tinybars, is_approval: false },
    { account: SELLER, amount: tinybars, is_approval: false },
  ];
}

/**
 * Build a mock MirrorClient where:
 *   - the topic stream returns the messages we constructed
 *   - verifyTransaction returns SUCCESS only for the txIds in `verifiedTxIds`
 */
function buildMockMirror({ topicMessages, verifiedTxIds, amountByTxId }) {
  /** @type {Set<string>} */
  const ok = new Set(verifiedTxIds.map((t) => t.replace('@', '-').replace(/\.(\d+)$/, '-$1')));
  return {
    baseUrl: 'https://example',
    getJson: async () => ({}),
    streamTopicMessages: async function* () {
      for (const m of topicMessages) yield m;
    },
    verifyTransaction: async (txId) => {
      const normalized = txId.replace('@', '-').replace(/\.(\d+)$/, '-$1');
      if (ok.has(normalized)) {
        return {
          verified: true,
          normalizedTxId: normalized,
          result: 'SUCCESS',
          consensusTimestamp: '1.1',
          hbarTransfers: settlementTransfers(amountByTxId[txId] ?? 1),
        };
      }
      return {
        verified: false,
        normalizedTxId: normalized,
        result: 'INVALID_TRANSACTION',
        consensusTimestamp: null,
        hbarTransfers: [],
        error: 'forged tx id',
      };
    },
  };
}

test('empty topic → score 0, no verified settlements', async () => {
  const mirror = buildMockMirror({ topicMessages: [], verifiedTxIds: [], amountByTxId: {} });
  const profile = await buildReputationProfile({
    mirror,
    topicId: TOPIC,
    counterparty: SELLER,
  });
  assert.equal(profile.score, 0);
  assert.equal(profile.verifiedSettlementCount, 0);
  assert.equal(profile.totalSettlementClaims, 0);
});

test('three verified settlements lift the score', async () => {
  const txA = '0.0.1001@1716736800.111111111';
  const txB = '0.0.1001@1716737000.222222222';
  const txC = '0.0.1001@1716737200.333333333';
  const messages = [
    { sequence_number: 1, consensus_timestamp: '1.1', topic_id: TOPIC, message: b64(settlementEnv(1, txA, 5)) },
    { sequence_number: 2, consensus_timestamp: '2.2', topic_id: TOPIC, message: b64(settlementEnv(2, txB, 3)) },
    { sequence_number: 3, consensus_timestamp: '3.3', topic_id: TOPIC, message: b64(settlementEnv(5, txC, 1)) },
  ];
  const mirror = buildMockMirror({
    topicMessages: messages,
    verifiedTxIds: [txA, txB, txC],
    amountByTxId: { [txA]: 1, [txB]: 2, [txC]: 5 },
  });
  const profile = await buildReputationProfile({
    mirror,
    topicId: TOPIC,
    counterparty: SELLER,
  });
  assert.equal(profile.verifiedSettlementCount, 3);
  assert.equal(profile.totalSettlementClaims, 3);
  assert.equal(profile.verifiedVolumeHbar, 8);
  assert.equal(profile.claimToVerifiedRatio, 1);
  assert.ok(profile.score > 0, `expected positive score, got ${profile.score}`);
});

test('a forged tx id drops out of the verified subset', async () => {
  const txReal = '0.0.1001@1716736800.111111111';
  const txForged = '0.0.1001@1716737000.999999999';
  const messages = [
    { sequence_number: 1, consensus_timestamp: '1.1', topic_id: TOPIC, message: b64(settlementEnv(1, txReal, 3)) },
    { sequence_number: 2, consensus_timestamp: '2.2', topic_id: TOPIC, message: b64(settlementEnv(99, txForged, 1)) },
  ];
  const mirror = buildMockMirror({
    topicMessages: messages,
    verifiedTxIds: [txReal], // only the real one verifies
    amountByTxId: { [txReal]: 1 },
  });
  const profile = await buildReputationProfile({
    mirror,
    topicId: TOPIC,
    counterparty: SELLER,
  });
  assert.equal(profile.verifiedSettlementCount, 1);
  assert.equal(profile.totalSettlementClaims, 2);
  assert.equal(profile.claimToVerifiedRatio, 0.5);
  assert.equal(profile.verifiedVolumeHbar, 1); // forged 99 HBAR claim discarded
});

test('mismatched transfer amount counts as unverified', async () => {
  const tx = '0.0.1001@1716736800.111111111';
  const messages = [
    { sequence_number: 1, consensus_timestamp: '1.1', topic_id: TOPIC, message: b64(settlementEnv(50, tx, 1)) },
  ];
  // mirror confirms a transfer but for the WRONG amount
  const mirror = {
    baseUrl: 'https://example',
    getJson: async () => ({}),
    streamTopicMessages: async function* () {
      for (const m of messages) yield m;
    },
    verifyTransaction: async () => ({
      verified: true,
      normalizedTxId: tx.replace('@', '-').replace(/\.(\d+)$/, '-$1'),
      result: 'SUCCESS',
      consensusTimestamp: '1.1',
      // claim says 50 HBAR, transfer says 1 HBAR — fraud!
      hbarTransfers: settlementTransfers(1),
    }),
  };
  const profile = await buildReputationProfile({
    mirror,
    topicId: TOPIC,
    counterparty: SELLER,
  });
  assert.equal(profile.verifiedSettlementCount, 0);
  assert.equal(profile.totalSettlementClaims, 1);
});

test('DENIAL envelopes lower the score', async () => {
  const txA = '0.0.1001@1716736800.111111111';
  const denial = {
    v: 1,
    type: 'DENIAL',
    ts: new Date().toISOString(),
    buyer: BUYER,
    seller: SELLER,
    service: 'funding-round-lookup',
    amountHbar: 999,
    policy: { ruleId: 'amount-exceeds-hard-cap', result: 'DENY', reason: 'too big' },
  };
  const messages = [
    { sequence_number: 1, consensus_timestamp: '1.1', topic_id: TOPIC, message: b64(settlementEnv(1, txA, 3)) },
    { sequence_number: 2, consensus_timestamp: '2.2', topic_id: TOPIC, message: b64(denial) },
  ];
  const mirror = buildMockMirror({
    topicMessages: messages,
    verifiedTxIds: [txA],
    amountByTxId: { [txA]: 1 },
  });
  const profile = await buildReputationProfile({
    mirror,
    topicId: TOPIC,
    counterparty: SELLER,
  });
  assert.equal(profile.denialCount, 1);
});

test('counterparty filter: envelopes about a different account are ignored', async () => {
  const txA = '0.0.1001@1716736800.111111111';
  const messages = [
    {
      sequence_number: 1,
      consensus_timestamp: '1.1',
      topic_id: TOPIC,
      message: b64({ ...settlementEnv(1, txA, 1), seller: '0.0.3003' }),
    },
  ];
  const mirror = buildMockMirror({
    topicMessages: messages,
    verifiedTxIds: [txA],
    amountByTxId: { [txA]: 1 },
  });
  const profile = await buildReputationProfile({
    mirror,
    topicId: TOPIC,
    counterparty: SELLER, // 0.0.2002, but the message is to 0.0.3003
  });
  assert.equal(profile.verifiedSettlementCount, 0);
  assert.equal(profile.totalSettlementClaims, 0);
});

test('garbage on the topic is silently ignored', async () => {
  const messages = [
    {
      sequence_number: 1,
      consensus_timestamp: '1.1',
      topic_id: TOPIC,
      message: Buffer.from('hello world', 'utf8').toString('base64'),
    },
    {
      sequence_number: 2,
      consensus_timestamp: '2.2',
      topic_id: TOPIC,
      message: Buffer.from('{"some":"other-protocol"}', 'utf8').toString('base64'),
    },
  ];
  const mirror = buildMockMirror({ topicMessages: messages, verifiedTxIds: [], amountByTxId: {} });
  const profile = await buildReputationProfile({
    mirror,
    topicId: TOPIC,
    counterparty: SELLER,
  });
  assert.equal(profile.totalSettlementClaims, 0);
});
