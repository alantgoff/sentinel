import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, describeService, QuerySchema, SERVICE_NAME, PRICE_HBAR_PER_QUERY } from '../src/agents/service.js';
import { queryFundingRounds, FUNDING_ROUNDS, SECTORS } from '../src/agents/service-data.js';

test('describeService returns a service descriptor', () => {
  const d = describeService();
  assert.equal(d.name, SERVICE_NAME);
  assert.equal(d.priceHbarPerQuery, PRICE_HBAR_PER_QUERY);
  assert.ok(Array.isArray(d.sectors));
  assert.ok(d.sectors.length > 0);
});

test('runQuery returns all rounds when no filters', () => {
  const out = runQuery({});
  assert.equal(out.count, FUNDING_ROUNDS.length);
  assert.equal(out.results.length, 10); // default limit
});

test('runQuery filters by sector', () => {
  const out = runQuery({ sector: 'Fintech', limit: 50 });
  assert.ok(out.results.length > 0);
  for (const r of out.results) assert.equal(r.sector, 'Fintech');
});

test('runQuery filters by minAmountUsdM', () => {
  const out = runQuery({ minAmountUsdM: 500, limit: 50 });
  for (const r of out.results) assert.ok(r.amountUsdM >= 500);
});

test('runQuery sorts by announcement date desc', () => {
  const out = runQuery({ limit: 50 });
  for (let i = 1; i < out.results.length; i++) {
    assert.ok(out.results[i - 1].announcedAt >= out.results[i].announcedAt);
  }
});

test('runQuery rejects malformed input via QuerySchema', () => {
  assert.throws(() => runQuery({ sinceDate: 'yesterday' }));
  assert.throws(() => runQuery({ limit: 0 }));
  assert.throws(() => runQuery({ minAmountUsdM: -1 }));
});

test('SECTORS is non-empty and sorted', () => {
  assert.ok(SECTORS.length > 0);
  const sorted = [...SECTORS].sort();
  assert.deepEqual(SECTORS, sorted);
});

test('queryFundingRounds direct API also works', () => {
  const out = queryFundingRounds({ company: 'anthropic' });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].company, 'Anthropic');
});
