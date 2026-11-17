import test from 'node:test';
import assert from 'node:assert/strict';
import { marketAlerts } from '../src/live/market-alerts.js';

test('market alerts include current Nasdaq halts and pending splits for that listing', () => {
  const alerts = marketAlerts('WYFI', { halts: [
    { symbol: 'WYFI', listed: true, state: 'halted', startedAt: 100, reasonCode: 'T1' },
    { symbol: 'CLSK', listed: true, state: 'halted', startedAt: 101, reasonCode: 'T1' },
    { symbol: 'WYFI', listed: true, state: 'resumed', startedAt: 90, reasonCode: 'T1' },
  ] }, { corporateActions: [
    { symbol: 'WYFI', id: '1', type: 'reverse_split', status: 'pending' },
    { symbol: 'WYFI', id: '2', type: 'split', status: 'completed' },
  ] });
  assert.deepEqual(alerts.map((item) => item.kind), ['halt', 'split']);
});

test('market alerts ignore non-listed and settled actions', () => {
  assert.deepEqual(marketAlerts('WYFI', { halts: [{ symbol: 'WYFI', listed: false, state: 'halted' }] }, { corporateActions: [] }), []);
});
