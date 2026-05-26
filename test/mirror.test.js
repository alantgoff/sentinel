import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMirrorClient, matchesExpectedTransfer } from '../src/hedera/mirror.js';

/**
 * Tiny fetch mock that returns scripted JSON responses keyed by URL substring.
 *
 * @param {Record<string, { status?: number, body: any }>} routes
 */
function mockFetch(routes) {
  /** @type {Array<string>} */
  const calls = [];
  /** @type {typeof fetch} */
  const fn = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    for (const [pattern, resp] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(resp.body), {
          status: resp.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404 });
  };
  return Object.assign(fn, { calls });
}

const BUYER = '0.0.1001';
const SELLER = '0.0.2002';
const TX = '0.0.1001@1716736800.123456789';
const TX_DASHED = '0.0.1001-1716736800-123456789';

const successPayload = {
  transactions: [
    {
      consensus_timestamp: '1716736801.111111111',
      transaction_id: TX_DASHED,
      result: 'SUCCESS',
      transfers: [
        { account: '0.0.98', amount: 47_000, is_approval: false },         // node fee
        { account: BUYER, amount: -150_000_000, is_approval: false },      // -1.5 HBAR
        { account: SELLER, amount: 150_000_000, is_approval: false },      // +1.5 HBAR
      ],
    },
  ],
};

test('verifyTransaction parses a SUCCESS payload', async () => {
  const fetchImpl = mockFetch({
    [`/api/v1/transactions/${TX_DASHED}`]: { body: successPayload },
  });
  const mirror = createMirrorClient({ baseUrl: 'https://example', fetchImpl });
  const v = await mirror.verifyTransaction(TX);
  assert.equal(v.verified, true);
  assert.equal(v.result, 'SUCCESS');
  assert.equal(v.normalizedTxId, TX_DASHED);
  assert.equal(v.hbarTransfers.length, 3);
});

test('matchesExpectedTransfer accepts a matching 1.5 HBAR transfer', async () => {
  const fetchImpl = mockFetch({
    [`/api/v1/transactions/${TX_DASHED}`]: { body: successPayload },
  });
  const mirror = createMirrorClient({ baseUrl: 'https://example', fetchImpl });
  const v = await mirror.verifyTransaction(TX);
  const m = matchesExpectedTransfer(v, { buyer: BUYER, seller: SELLER, amountHbar: 1.5 });
  assert.deepEqual(m, { ok: true });
});

test('matchesExpectedTransfer rejects wrong amount', async () => {
  const fetchImpl = mockFetch({
    [`/api/v1/transactions/${TX_DASHED}`]: { body: successPayload },
  });
  const mirror = createMirrorClient({ baseUrl: 'https://example', fetchImpl });
  const v = await mirror.verifyTransaction(TX);
  const m = matchesExpectedTransfer(v, { buyer: BUYER, seller: SELLER, amountHbar: 99 });
  assert.equal(m.ok, false);
});

test('matchesExpectedTransfer accepts buyer paying transfer + network fee', async () => {
  // In real testnet runs the buyer is also the transaction payer, so their
  // debit is -(transferAmount + fee). The seller credit is exact; the buyer
  // debit is >= transferAmount.
  const realPayload = {
    transactions: [
      {
        consensus_timestamp: '1716736801.111111111',
        transaction_id: TX_DASHED,
        result: 'SUCCESS',
        transfers: [
          { account: '0.0.802', amount: 115_151, is_approval: false },       // node fee
          { account: BUYER,     amount: -50_115_151, is_approval: false },   // -0.5 HBAR - fee
          { account: SELLER,    amount: 50_000_000, is_approval: false },    // +0.5 HBAR
        ],
      },
    ],
  };
  const fetchImpl = mockFetch({
    [`/api/v1/transactions/${TX_DASHED}`]: { body: realPayload },
  });
  const mirror = createMirrorClient({ baseUrl: 'https://example', fetchImpl });
  const v = await mirror.verifyTransaction(TX);
  const m = matchesExpectedTransfer(v, { buyer: BUYER, seller: SELLER, amountHbar: 0.5 });
  assert.deepEqual(m, { ok: true });
});

test('matchesExpectedTransfer rejects when buyer was credited not debited', async () => {
  const reversed = {
    transactions: [
      {
        consensus_timestamp: '1716736801.111111111',
        transaction_id: TX_DASHED,
        result: 'SUCCESS',
        transfers: [
          { account: BUYER,  amount: 50_000_000, is_approval: false },   // wrong: buyer received
          { account: SELLER, amount: -50_115_151, is_approval: false },  // wrong: seller paid
        ],
      },
    ],
  };
  const fetchImpl = mockFetch({
    [`/api/v1/transactions/${TX_DASHED}`]: { body: reversed },
  });
  const mirror = createMirrorClient({ baseUrl: 'https://example', fetchImpl });
  const v = await mirror.verifyTransaction(TX);
  const m = matchesExpectedTransfer(v, { buyer: BUYER, seller: SELLER, amountHbar: 0.5 });
  assert.equal(m.ok, false);
});

test('matchesExpectedTransfer rejects wrong counterparty', async () => {
  const fetchImpl = mockFetch({
    [`/api/v1/transactions/${TX_DASHED}`]: { body: successPayload },
  });
  const mirror = createMirrorClient({ baseUrl: 'https://example', fetchImpl });
  const v = await mirror.verifyTransaction(TX);
  const m = matchesExpectedTransfer(v, { buyer: BUYER, seller: '0.0.9999', amountHbar: 1.5 });
  assert.equal(m.ok, false);
});

test('verifyTransaction reports FAIL result', async () => {
  const failPayload = {
    transactions: [
      {
        consensus_timestamp: '1716736801.111111111',
        transaction_id: TX_DASHED,
        result: 'INSUFFICIENT_PAYER_BALANCE',
        transfers: [],
      },
    ],
  };
  const fetchImpl = mockFetch({
    [`/api/v1/transactions/${TX_DASHED}`]: { body: failPayload },
  });
  const mirror = createMirrorClient({ baseUrl: 'https://example', fetchImpl });
  const v = await mirror.verifyTransaction(TX);
  assert.equal(v.verified, false);
  assert.equal(v.result, 'INSUFFICIENT_PAYER_BALANCE');
});

test('verifyTransaction reports missing record', async () => {
  const fetchImpl = mockFetch({
    [`/api/v1/transactions/${TX_DASHED}`]: { body: { transactions: [] } },
  });
  const mirror = createMirrorClient({ baseUrl: 'https://example', fetchImpl });
  const v = await mirror.verifyTransaction(TX);
  assert.equal(v.verified, false);
  assert.match(v.error ?? '', /no transaction/);
});

test('verifyTransaction handles 404', async () => {
  const fetchImpl = mockFetch({});  // every URL 404s
  const mirror = createMirrorClient({ baseUrl: 'https://example', fetchImpl });
  const v = await mirror.verifyTransaction(TX);
  assert.equal(v.verified, false);
  assert.ok(v.error);
});

test('streamTopicMessages yields all messages across pages', async () => {
  const page1 = {
    messages: [
      { consensus_timestamp: '1.1', sequence_number: 1, topic_id: '0.0.99', message: 'aGVsbG8=' },
      { consensus_timestamp: '2.2', sequence_number: 2, topic_id: '0.0.99', message: 'd29ybGQ=' },
    ],
    links: { next: '/api/v1/topics/0.0.99/messages?cursor=2' },
  };
  const page2 = {
    messages: [
      { consensus_timestamp: '3.3', sequence_number: 3, topic_id: '0.0.99', message: 'IQ==' },
    ],
    links: { next: null },
  };
  const fetchImpl = mockFetch({
    'cursor=2': { body: page2 },
    '/api/v1/topics/0.0.99/messages': { body: page1 },
  });
  const mirror = createMirrorClient({ baseUrl: 'https://example', fetchImpl });
  const seen = [];
  for await (const msg of mirror.streamTopicMessages('0.0.99')) seen.push(msg.sequence_number);
  assert.deepEqual(seen, [1, 2, 3]);
});
