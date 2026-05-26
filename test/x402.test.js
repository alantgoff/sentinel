import { test } from 'node:test';
import assert from 'node:assert/strict';
import { x402Fetch } from '../src/x402-client.js';

function recordingFetch(scripts) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const i = calls.length;
    calls.push({ url, headers: Object.fromEntries(new Headers(init.headers ?? {})) });
    const r = scripts[i];
    if (!r) throw new Error(`unexpected request #${i} to ${url}`);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn, calls };
}

const QUOTE = {
  requestId: 'req-1',
  service: 'funding-round-lookup',
  priceHbar: 0.5,
  payTo: '0.0.2002',
  network: 'testnet',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

test('happy path: 402 → settle → 200', async () => {
  const { fn, calls } = recordingFetch([
    { status: 402, body: { error: 'payment required', x402: QUOTE } },
    { status: 200, body: { ok: true, data: { count: 1, results: [] } } },
  ]);
  const signer = { payQuote: async (q) => {
    assert.equal(q.requestId, 'req-1');
    return '0.0.1001@1234.5';
  } };
  const out = await x402Fetch({
    url: 'https://example/seller/api/funding-rounds',
    signer,
    buyer: '0.0.1001',
    opts: { fetchImpl: fn },
  });
  assert.equal(out.status, 200);
  assert.equal(out.txId, '0.0.1001@1234.5');
  assert.equal(calls[1].headers['x-payment'], 'req-1:0.0.1001@1234.5');
  assert.equal(calls[1].headers['x-buyer'], '0.0.1001');
});

test('non-402 first response is returned as-is', async () => {
  const { fn } = recordingFetch([
    { status: 200, body: { precached: true } },
  ]);
  const signer = { payQuote: async () => { throw new Error('should not be called'); } };
  const out = await x402Fetch({
    url: 'https://example/anything',
    signer,
    opts: { fetchImpl: fn },
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.data, { precached: true });
});

test('malformed 402 payload throws', async () => {
  const { fn } = recordingFetch([
    { status: 402, body: { x402: { lol: true } } },
  ]);
  const signer = { payQuote: async () => 'irrelevant' };
  await assert.rejects(
    x402Fetch({ url: 'https://x', signer, opts: { fetchImpl: fn } }),
    /malformed/,
  );
});

test('signer failure propagates', async () => {
  const { fn } = recordingFetch([
    { status: 402, body: { x402: QUOTE } },
  ]);
  const signer = { payQuote: async () => { throw new Error('policy DENIED'); } };
  await assert.rejects(
    x402Fetch({ url: 'https://x', signer, opts: { fetchImpl: fn } }),
    /policy DENIED/,
  );
});
