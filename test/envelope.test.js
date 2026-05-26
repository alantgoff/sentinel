import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Envelope,
  parseEnvelope,
  safeParseEnvelope,
  encodeEnvelope,
  decodeEnvelope,
  normalizeTxId,
} from '../src/hedera/envelope.js';

const BASE = {
  v: 1,
  ts: '2026-05-26T15:00:00.000Z',
  buyer: '0.0.1001',
  seller: '0.0.2002',
  service: 'funding-round-lookup',
  amountHbar: 1.5,
};

test('parses a QUOTE', () => {
  const env = parseEnvelope({ ...BASE, type: 'QUOTE' });
  assert.equal(env.type, 'QUOTE');
});

test('parses a SETTLEMENT with a txId', () => {
  const env = parseEnvelope({
    ...BASE,
    type: 'SETTLEMENT',
    txId: '0.0.1001@1716736800.123456789',
  });
  assert.equal(env.type, 'SETTLEMENT');
  if (env.type === 'SETTLEMENT') assert.match(env.txId, /^0\.0\.1001@\d+\.\d+$/);
});

test('SETTLEMENT requires a txId', () => {
  const r = safeParseEnvelope({ ...BASE, type: 'SETTLEMENT' });
  assert.equal(r.success, false);
});

test('POLICY_DECISION requires policy block', () => {
  const r = safeParseEnvelope({ ...BASE, type: 'POLICY_DECISION' });
  assert.equal(r.success, false);
  const r2 = safeParseEnvelope({
    ...BASE,
    type: 'POLICY_DECISION',
    policy: { ruleId: 'cap-new-counterparty', result: 'ESCALATE', reason: 'thin history' },
  });
  assert.equal(r2.success, true);
});

test('DENIAL must carry DENY or ESCALATE policy result', () => {
  const r = safeParseEnvelope({
    ...BASE,
    type: 'DENIAL',
    policy: { ruleId: 'r', result: 'ALLOW', reason: 'oops' },
  });
  assert.equal(r.success, false);
});

test('rejects v != 1', () => {
  const r = safeParseEnvelope({ ...BASE, v: 2, type: 'QUOTE' });
  assert.equal(r.success, false);
});

test('rejects malformed account id', () => {
  const r = safeParseEnvelope({ ...BASE, buyer: 'alice', type: 'QUOTE' });
  assert.equal(r.success, false);
});

test('rejects negative amount', () => {
  const r = safeParseEnvelope({ ...BASE, amountHbar: -0.01, type: 'QUOTE' });
  assert.equal(r.success, false);
});

test('encode → decode roundtrip via base64 layer', () => {
  const env = {
    ...BASE,
    type: 'SETTLEMENT',
    txId: '0.0.1001@1716736800.123456789',
  };
  const json = encodeEnvelope(env);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const back = decodeEnvelope(b64);
  assert.ok(back);
  assert.equal(back.type, 'SETTLEMENT');
  if (back.type === 'SETTLEMENT') {
    assert.equal(back.txId, env.txId);
    assert.equal(back.buyer, env.buyer);
    assert.equal(back.amountHbar, env.amountHbar);
  }
});

test('decodeEnvelope returns null on garbage', () => {
  assert.equal(decodeEnvelope(Buffer.from('not json', 'utf8').toString('base64')), null);
  assert.equal(decodeEnvelope(Buffer.from('{"hello":"world"}', 'utf8').toString('base64')), null);
});

test('decodeEnvelope handles alreadyDecoded=true', () => {
  const json = encodeEnvelope({ ...BASE, type: 'QUOTE' });
  const back = decodeEnvelope(json, { alreadyDecoded: true });
  assert.ok(back);
  assert.equal(back.type, 'QUOTE');
});

test('normalizeTxId converts @/. form to dashed mirror form', () => {
  assert.equal(
    normalizeTxId('0.0.1001@1716736800.123456789'),
    '0.0.1001-1716736800-123456789',
  );
  // Idempotent on already-normalized.
  assert.equal(
    normalizeTxId('0.0.1001-1716736800-123456789'),
    '0.0.1001-1716736800-123456789',
  );
});

test('Envelope type union covers exactly four types', () => {
  // sanity: discriminator options
  const types = Envelope.options.map((s) => s.shape.type.value);
  assert.deepEqual(types.sort(), ['DENIAL', 'POLICY_DECISION', 'QUOTE', 'SETTLEMENT']);
});
