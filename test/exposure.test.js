import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExposureBook } from '../src/pool/exposure.js';

test('empty book: no exposure, full headroom', () => {
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  const snap = book.snapshot(100);
  assert.equal(snap.poolBalanceHbar, 100);
  assert.equal(snap.maxExposureHbar, 50);
  assert.equal(snap.currentExposureHbar, 0);
  assert.equal(snap.headroomHbar, 50);
  assert.equal(snap.activePolicyCount, 0);
});

test('add policy increases exposure; settlement releases it', () => {
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  book.add({ policyId: 'p1', buyer: '0.0.1001', maxPayoutHbar: 20, windowEndsTs: '2026-06-30T00:00:00.000Z' });
  assert.equal(book.snapshot(100).currentExposureHbar, 20);

  book.add({ policyId: 'p2', buyer: '0.0.1002', maxPayoutHbar: 10, windowEndsTs: '2026-07-01T00:00:00.000Z' });
  assert.equal(book.snapshot(100).currentExposureHbar, 30);

  book.remove('p1');
  assert.equal(book.snapshot(100).currentExposureHbar, 10);
  assert.equal(book.has('p1'), false);
  assert.equal(book.has('p2'), true);
});

test('checkIssuance refuses when proposed pushes over the cap', () => {
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  book.add({ policyId: 'p1', buyer: '0.0.1001', maxPayoutHbar: 30, windowEndsTs: '2026-06-30T00:00:00.000Z' });
  // pool 100 × 0.5 = 50 max exposure. Current 30. Proposed 25 → would be 55 > 50.
  const res = book.checkIssuance({ poolBalanceHbar: 100, proposedMaxPayoutHbar: 25 });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /exceed|cap|pool/i);
  assert.equal(res.snapshot.currentExposureHbar, 30);
  assert.equal(res.proposedExposureHbar, 55);
});

test('checkIssuance accepts at the boundary', () => {
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  book.add({ policyId: 'p1', buyer: '0.0.1001', maxPayoutHbar: 30, windowEndsTs: '2026-06-30T00:00:00.000Z' });
  // proposed 20 → exactly 50, equal to cap → ok.
  const res = book.checkIssuance({ poolBalanceHbar: 100, proposedMaxPayoutHbar: 20 });
  assert.equal(res.ok, true);
});

test('checkIssuance refuses when pool balance is 0', () => {
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  const res = book.checkIssuance({ poolBalanceHbar: 0, proposedMaxPayoutHbar: 1 });
  assert.equal(res.ok, false);
});

test('dropExpired removes only policies whose window has ended', () => {
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  book.add({ policyId: 'p1', buyer: '0.0.1001', maxPayoutHbar: 10, windowEndsTs: '2026-05-01T00:00:00.000Z' });
  book.add({ policyId: 'p2', buyer: '0.0.1002', maxPayoutHbar: 10, windowEndsTs: '2026-12-01T00:00:00.000Z' });
  const released = book.dropExpired('2026-06-01T00:00:00.000Z');
  assert.deepEqual(released, ['p1']);
  assert.equal(book.has('p1'), false);
  assert.equal(book.has('p2'), true);
});

test('list is sorted by window end ascending', () => {
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  book.add({ policyId: 'p1', buyer: '0.0.1001', maxPayoutHbar: 5, windowEndsTs: '2026-07-01T00:00:00.000Z' });
  book.add({ policyId: 'p2', buyer: '0.0.1002', maxPayoutHbar: 5, windowEndsTs: '2026-05-15T00:00:00.000Z' });
  book.add({ policyId: 'p3', buyer: '0.0.1003', maxPayoutHbar: 5, windowEndsTs: '2026-06-01T00:00:00.000Z' });
  const ordered = book.list().map((p) => p.policyId);
  assert.deepEqual(ordered, ['p2', 'p3', 'p1']);
});

test('add is idempotent on policyId', () => {
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  book.add({ policyId: 'p1', buyer: '0.0.1001', maxPayoutHbar: 10, windowEndsTs: '2026-06-30T00:00:00.000Z' });
  book.add({ policyId: 'p1', buyer: '0.0.1001', maxPayoutHbar: 20, windowEndsTs: '2026-06-30T00:00:00.000Z' });
  // Replaces the first record.
  assert.equal(book.snapshot(100).currentExposureHbar, 20);
});

test('validates constructor and inputs', () => {
  assert.throws(() => createExposureBook({ maxExposureRatio: 0 }));
  assert.throws(() => createExposureBook({ maxExposureRatio: 1.1 }));
  const book = createExposureBook({ maxExposureRatio: 0.5 });
  assert.throws(() => book.add({ maxPayoutHbar: 10, windowEndsTs: '2026-06-30T00:00:00.000Z' }));
  assert.throws(() => book.add({ policyId: 'p1', maxPayoutHbar: 0, windowEndsTs: '2026-06-30T00:00:00.000Z' }));
  assert.throws(() => book.snapshot(-5));
  assert.throws(() => book.checkIssuance({ poolBalanceHbar: 100, proposedMaxPayoutHbar: -1 }));
  assert.throws(() => book.dropExpired('not-iso'));
});
