import assert from 'node:assert/strict';
import test from 'node:test';
import { hasRealizedPnl, pnlShareCaption } from '../src/live/pnlCard.js';

const trade = (overrides = {}) => ({
  symbol: 'WYFI',
  side: 'sell',
  path: 'Close at mark',
  liquidation: false,
  at: Date.UTC(2026, 10, 16, 12, 30),
  txHash: '0x1234567890abcdef',
  realizedPnlUsdg: '1234567',
  feeUsdg: '234567',
  ...overrides,
});

test('share caption reports realized P&L less this fill fee and includes its explorer proof', () => {
  const caption = pnlShareCaption(trade(), '0x2241d50bfe090beb20a2521bdaf351c42446d73c');
  assert.match(caption, /\+\$1\.00 USDG realized after recorded fee/);
  assert.match(caption, /On-chain execution record: https:\/\/robinhoodchain\.blockscout\.com\/tx\/0x1234567890abcdef/);
  assert.match(caption, /Single indexed fill; borrow and other account activity excluded/);
});

test('share caption keeps negative fee-adjusted P&L signed and only realized fills are shareable', () => {
  const loss = trade({ realizedPnlUsdg: '-1250000', feeUsdg: '250000' });
  assert.match(pnlShareCaption(loss, '0x2241d50bfe090beb20a2521bdaf351c42446d73c'), /−\$1\.50 USDG realized/);
  assert.equal(hasRealizedPnl(loss), true);
  assert.equal(hasRealizedPnl(trade({ realizedPnlUsdg: '0' })), false);
});
