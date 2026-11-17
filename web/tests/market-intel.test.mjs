import test from 'node:test';
import assert from 'node:assert/strict';
import { marketIntel } from '../src/live/market-intel.js';

test('market intel keeps filings and catalysts scoped to the selected market', () => {
  const result = marketIntel('WYFI', [
    { symbol: 'WYFI', tags: ['dilution'] },
    { symbol: 'CLSK', tags: ['offering'] },
  ], {
    earnings: [{ symbol: 'WYFI', next: { date: '2026-12-01' } }, { symbol: 'CLSK', next: { date: '2026-12-02' } }],
    corporateActions: [{ symbol: 'WYFI', type: 'split' }, { symbol: 'CLSK', type: 'dividend' }],
  });
  assert.equal(result.filings.length, 1);
  assert.equal(result.earnings.date, '2026-12-01');
  assert.equal(result.actions.length, 1);
  assert.equal(result.sentiment, 'Risk flagged');
});

test('market intel does not label missing filings as neutral sentiment', () => {
  assert.equal(marketIntel('WYFI').sentiment, 'Not enough filing data');
});
