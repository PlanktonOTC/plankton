import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTradeExport, taxReportCsv, tradeHistoryCsv } from '../src/live/tradeExport.js';

const trade = (overrides = {}) => ({
  at: '2026-07-08T12:30:00.000Z',
  sizeDeltaE18: '1500000000000000000',
  priceE18: '2000000000000000000',
  realizedPnlUsdg: '-500000',
  feeUsdg: '10000',
  symbol: 'WYFI',
  marketId: `0x${'12'.repeat(32)}`,
  path: 0,
  txHash: `0x${'34'.repeat(32)}`,
  block: '123',
  logIndex: 1,
  ...overrides,
});

test('trade history CSV keeps exact decimal values and transaction links', () => {
  const csv = tradeHistoryCsv([trade()]);
  assert.match(csv, /Timestamp \(UTC\),Tax year \(UTC\),Market,Side/);
  assert.match(csv, /2026-07-08T12:30:00\.000Z,2026,WYFI,buy,1\.5,2,3,0\.01,-0\.5,-0\.51/);
  assert.match(csv, /https:\/\/robinhoodchain\.blockscout\.com\/tx\/0x3434/);
});

test('tax report totals realized P&L and fees separately for the selected UTC year', () => {
  const csv = taxReportCsv(`0x${'ab'.repeat(20)}`, 2026, [
    trade(),
    trade({ at: '2026-07-09T12:30:00.000Z', realizedPnlUsdg: '1000000', feeUsdg: '20000', sizeDeltaE18: '-1500000000000000000', path: 2 }),
  ]);
  assert.match(csv, /Tax year \(UTC\),2026/);
  assert.match(csv, /Realized P&L before fees \(USDG\),0\.5/);
  assert.match(csv, /Recorded trade fees \(USDG\),0\.03/);
  assert.match(csv, /Realized P&L less all recorded trade fees \(USDG\),0\.47/);
  assert.match(csv, /borrow, deposits, withdrawals, liquidity activity/);
});

test('trade export fetches every cursor page sequentially with the selected year', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url, 'https://plankton.test'));
    const body = calls.length === 1
      ? { trades: [{ id: 1 }], nextCursor: { cursorAt: '2026-07-08T12:30:00.000Z', cursorTx: `0x${'12'.repeat(32)}`, cursorLog: 4 } }
      : { trades: [{ id: 2 }], nextCursor: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const rows = await fetchTradeExport(`0x${'ab'.repeat(20)}`, 2026);
    assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].searchParams.get('year'), '2026');
    assert.equal(calls[1].searchParams.get('cursorLog'), '4');
    assert.equal(calls[1].searchParams.get('cursorTx'), `0x${'12'.repeat(32)}`);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
