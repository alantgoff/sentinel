import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Envelope,
  ENVELOPE_TYPES,
  parseEnvelope,
  safeParseEnvelope,
  encodeEnvelope,
  decodeEnvelope,
  normalizeTxId,
} from '../src/hedera/envelope.js';

const NOW = '2026-05-26T15:00:00.000Z';
const LATER = '2026-06-25T15:00:00.000Z';
const TX = '0.0.1001@1716736800.123456789';
const TX2 = '0.0.2002@1716736900.987654321';

const POLICY = {
  v: 1,
  type: 'POLICY',
  ts: NOW,
  policyId: 'pol-1',
  buyer: '0.0.1001',
  underwriter: '0.0.2002',
  class: 'H100',
  strikeUsdHr: 4.5,
  qtyGpuHr: 1000,
  windowEndsTs: LATER,
  premiumHbar: 12.3,
  premiumTxId: TX,
  maxPayoutHbar: 200,
};

test('Envelope union covers exactly the four declared types', () => {
  assert.deepEqual([...ENVELOPE_TYPES].sort(), ['POLICY', 'PRICE_REF', 'PROVIDER_CAPACITY', 'SETTLEMENT']);
});

test('parses a POLICY envelope', () => {
  const env = parseEnvelope(POLICY);
  assert.equal(env.type, 'POLICY');
  if (env.type === 'POLICY') {
    assert.equal(env.strikeUsdHr, 4.5);
    assert.equal(env.qtyGpuHr, 1000);
    assert.equal(env.class, 'H100');
  }
});

test('POLICY requires premiumTxId', () => {
  const { premiumTxId, ...rest } = POLICY;
  assert.equal(safeParseEnvelope(rest).success, false);
});

test('POLICY rejects non-H100 class (for now)', () => {
  assert.equal(safeParseEnvelope({ ...POLICY, class: 'A100' }).success, false);
});

test('PRICE_REF accepts sim:labeled source', () => {
  const env = parseEnvelope({
    v: 1, type: 'PRICE_REF', ts: NOW,
    observedUsdHr: 4.95, source: 'sim:labeled',
  });
  assert.equal(env.type, 'PRICE_REF');
});

test('PRICE_REF accepts calibration:<id> source', () => {
  const env = parseEnvelope({
    v: 1, type: 'PRICE_REF', ts: NOW,
    observedUsdHr: 4.95, source: 'calibration:lambda-h100-2024',
  });
  assert.equal(env.type, 'PRICE_REF');
});

test('PRICE_REF rejects unlabeled source', () => {
  assert.equal(
    safeParseEnvelope({ v: 1, type: 'PRICE_REF', ts: NOW, observedUsdHr: 4.95, source: 'live' }).success,
    false,
  );
});

test('SETTLEMENT PAID_OUT requires payout fields', () => {
  const ok = parseEnvelope({
    v: 1, type: 'SETTLEMENT', ts: LATER,
    policyId: 'pol-1', result: 'PAID_OUT',
    observedUsdHr: 6.10, payoutHbar: 50, payoutTxId: TX2,
  });
  assert.equal(ok.type, 'SETTLEMENT');
  // Missing payoutTxId → fail
  assert.equal(
    safeParseEnvelope({ v: 1, type: 'SETTLEMENT', ts: LATER, policyId: 'pol-1', result: 'PAID_OUT', observedUsdHr: 6.10, payoutHbar: 50, payoutTxId: null }).success,
    false,
  );
  // payoutHbar 0 → fail
  assert.equal(
    safeParseEnvelope({ v: 1, type: 'SETTLEMENT', ts: LATER, policyId: 'pol-1', result: 'PAID_OUT', observedUsdHr: 6.10, payoutHbar: 0, payoutTxId: TX2 }).success,
    false,
  );
});

test('SETTLEMENT EXPIRED requires zero payout + null txId', () => {
  const ok = parseEnvelope({
    v: 1, type: 'SETTLEMENT', ts: LATER,
    policyId: 'pol-1', result: 'EXPIRED',
    observedUsdHr: 4.20, payoutHbar: 0, payoutTxId: null,
  });
  assert.equal(ok.type, 'SETTLEMENT');
  // EXPIRED with payoutHbar > 0 → fail
  assert.equal(
    safeParseEnvelope({ v: 1, type: 'SETTLEMENT', ts: LATER, policyId: 'pol-1', result: 'EXPIRED', observedUsdHr: 4.20, payoutHbar: 50, payoutTxId: null }).success,
    false,
  );
  // EXPIRED with txId set → fail
  assert.equal(
    safeParseEnvelope({ v: 1, type: 'SETTLEMENT', ts: LATER, policyId: 'pol-1', result: 'EXPIRED', observedUsdHr: 4.20, payoutHbar: 0, payoutTxId: TX2 }).success,
    false,
  );
});

test('PROVIDER_CAPACITY accepts a capacity post', () => {
  const env = parseEnvelope({
    v: 1, type: 'PROVIDER_CAPACITY', ts: NOW,
    provider: '0.0.3003', class: 'H100', qtyGpuHr: 500, askUsdHr: 4.2,
    availableUntilTs: LATER,
  });
  assert.equal(env.type, 'PROVIDER_CAPACITY');
});

test('rejects v != 1', () => {
  assert.equal(safeParseEnvelope({ ...POLICY, v: 2 }).success, false);
});

test('rejects malformed account id', () => {
  assert.equal(safeParseEnvelope({ ...POLICY, buyer: 'not-an-account' }).success, false);
});

test('encode → decode roundtrip via base64 layer', () => {
  const json = encodeEnvelope(POLICY);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const back = decodeEnvelope(b64);
  assert.ok(back);
  assert.equal(back.type, 'POLICY');
  if (back.type === 'POLICY') {
    assert.equal(back.policyId, POLICY.policyId);
    assert.equal(back.strikeUsdHr, POLICY.strikeUsdHr);
  }
});

test('decodeEnvelope returns null on garbage', () => {
  assert.equal(decodeEnvelope(Buffer.from('not json', 'utf8').toString('base64')), null);
  assert.equal(decodeEnvelope(Buffer.from('{"other":"protocol"}', 'utf8').toString('base64')), null);
});

test('decodeEnvelope handles alreadyDecoded=true', () => {
  const json = encodeEnvelope(POLICY);
  const back = decodeEnvelope(json, { alreadyDecoded: true });
  assert.ok(back);
  assert.equal(back?.type, 'POLICY');
});

test('normalizeTxId converts @/. form to dashed mirror form', () => {
  assert.equal(normalizeTxId('0.0.1001@1716736800.123456789'), '0.0.1001-1716736800-123456789');
  assert.equal(normalizeTxId('0.0.1001-1716736800-123456789'), '0.0.1001-1716736800-123456789');
});
