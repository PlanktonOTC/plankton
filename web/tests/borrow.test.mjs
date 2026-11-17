import test from 'node:test';
import assert from 'node:assert/strict';
import { borrowEstimate } from '../src/live/borrow.js';

test('borrow estimate compounds current hourly basis-point rate as simple holding cost', () => {
  assert.ok(Math.abs(borrowEstimate(1_000, 2, 24) - 4.8) < 1e-9);
  assert.ok(Math.abs(borrowEstimate(1_000, 2, 168) - 33.6) < 1e-9);
});

test('borrow estimate safely handles missing or invalid values', () => {
  assert.equal(borrowEstimate(0, 2, 24), 0);
  assert.equal(borrowEstimate(1_000, -1, 24), 0);
  assert.equal(borrowEstimate(Number.NaN, 2, 24), 0);
});
