import test from 'node:test';
import assert from 'node:assert/strict';
import { earningsModeFor } from '../src/live/earnings-mode.js';

const earnings = [{ symbol: 'WYFI', next: { date: '2026-11-18' } }];

test('earnings mode covers the day before, earnings day and following day in New York time', () => {
  assert.equal(earningsModeFor(earnings, 'WYFI', Date.parse('2026-11-17T17:00:00Z')).active, true);
  assert.equal(earningsModeFor(earnings, 'WYFI', Date.parse('2026-11-19T17:00:00Z')).active, true);
  assert.equal(earningsModeFor(earnings, 'WYFI', Date.parse('2026-11-20T17:00:00Z')).active, false);
});

test('earnings mode is market-specific and stays off without a dated report', () => {
  assert.equal(earningsModeFor(earnings, 'CLSK', Date.parse('2026-11-18T17:00:00Z')).active, false);
  assert.equal(earningsModeFor([], 'WYFI').active, false);
});
