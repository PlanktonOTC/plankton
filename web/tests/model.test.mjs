import test from 'node:test';
import assert from 'node:assert/strict';
import { accountView, companyName, marketView, orderView, positionView, previewView, protectionFor, relativeTime, tradeView } from '../src/live/model.js';

const e18 = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString();
const usdg = (n) => String(Math.round(n * 1e6));

// A market as GET /v1/markets returns it (bigints as decimal strings).
const apiMarket = (over = {}) => ({
  symbol: 'USAR',
  class: 'smid',
  marketId: `0x${'ab'.repeat(32)}`,
  markFeedUp: true,
  mark: { symbol: 'USAR', status: 'open', priceE18: e18(20), refCloseE18: e18(19), confidenceBps: 12, dispersionBps: 8, sources: ['chainlink', 'rh_quote'], freezeReasons: [], openGuard: false, session: 'open', eligible: true, eligibilityReasons: [] },
  trading: {
    state: 1, opensAllowed: true, maxLeverage: 3, openSpreadBps: 5, frozenSpreadBps: 200, feeBps: 8, borrowBaseBpsPerHour: 4, maintenanceMarginBps: 500, minHoldSec: 60,
    positionCapUsdg: usdg(1000), longRoomUsdg: usdg(3000), shortRoomUsdg: usdg(2500), deleveraging: false, navUsdg: usdg(100000), longOiUsdg: usdg(400), shortOiUsdg: usdg(100),
    markE18: e18(20), markStatus: 1, markUpdatedAt: '1700000000', markConfidenceBps: 12, markSequence: '4',
  },
  ...over,
});

test('a healthy market is tradable and reports its numbers in plain units', () => {
  const m = marketView(apiMarket());
  assert.equal(m.name, 'USA Rare Earth');
  assert.equal(m.price, 20);
  assert.equal(m.change, ((20 - 19) / 19) * 100);
  assert.equal(m.canOpen, true);
  assert.deepEqual(m.blockers, []);
  assert.equal(m.limits.maxLeverage, 3);
  assert.equal(m.limits.positionCap, 1000);
  assert.equal(m.limits.longRoom, 3000);
  assert.equal(m.statusLabel, 'Open');
});

test('weekend and extended hours can still open; frozen and halted cannot', () => {
  const weekend = marketView(apiMarket({ mark: { ...apiMarket().mark, status: 'weekend' } }));
  assert.equal(weekend.canOpen, true);
  for (const status of ['frozen', 'halted']) {
    const m = marketView(apiMarket({ mark: { ...apiMarket().mark, status } }));
    assert.equal(m.canOpen, false, status);
    assert.ok(m.blockers.length > 0);
  }
});

test('close-only, paused, deleveraging, opens-not-allowed and no price each stop opens with a reason', () => {
  const t = apiMarket().trading;
  const cases = [
    [{ state: 2 }, /close-only/],
    [{ state: 3 }, /paused/],
    [{ deleveraging: true }, /deleveraging/i],
    [{ opensAllowed: false }, /not allowed/],
    [{ markE18: '0' }, /no price/],
  ];
  for (const [patch, re] of cases) {
    const m = marketView(apiMarket({ mark: null, trading: { ...t, ...patch } }));
    assert.equal(m.canOpen, false, JSON.stringify(patch));
    assert.match(m.blockers.join(' '), re);
  }
});

test('with the contracts unreachable the market is listed but not tradable', () => {
  const m = marketView(apiMarket({ trading: null }));
  assert.equal(m.canOpen, false);
  assert.equal(m.limits, null);
  assert.match(m.blockers[0], /not reachable/);
});

test('with the price feed down the on-chain price still shows, flagged as down', () => {
  const m = marketView(apiMarket({ mark: null, markFeedUp: false }));
  assert.equal(m.feedUp, false);
  assert.equal(m.price, 20);
  assert.equal(m.change, null); // no reference close without the feed
  assert.equal(m.status, 'open'); // falls back to the on-chain status
});

test('listing-rule findings are shown as warnings, not as a stop on trading', () => {
  const m = marketView(apiMarket({ mark: { ...apiMarket().mark, eligible: false, eligibilityReasons: ['market cap above the listing band'] } }));
  assert.deepEqual(m.warnings, ['market cap above the listing band']);
  assert.equal(m.canOpen, true);
  assert.deepEqual(m.blockers, []);
});

test('each market state has its own plain explanation', () => {
  for (const status of ['open', 'extended', 'weekend', 'frozen', 'halted']) {
    const m = marketView(apiMarket({ mark: { ...apiMarket().mark, status } }));
    assert.ok(m.statusNote.length > 20, status);
  }
  assert.match(marketView(apiMarket({ mark: { ...apiMarket().mark, status: 'halted' } })).blockers[0], /halted/i);
});

test('unknown tickers fall back to the ticker as their name', () => {
  assert.equal(companyName('ZZZZ'), 'ZZZZ');
});

// A position as GET /v1/accounts/:addr/state returns it.
const apiPosition = (over = {}) => ({
  symbol: 'USAR', marketId: `0x${'ab'.repeat(32)}`, sizeE18: e18(15), entryE18: e18(20), marginUsdg: usdg(100), openedAt: '1700000000', markE18: e18(21),
  maintenanceMarginBps: 500, liquidationE18: e18(14.5), notionalUsdg: usdg(315), pnlUsdg: usdg(15), equityUsdg: usdg(115), maintenanceUsdg: usdg(15.75), bufferUsdg: usdg(99.25), ...over,
});

test('a long in profit: figures, health and distance to liquidation', () => {
  const p = positionView(apiPosition());
  assert.equal(p.side, 'long');
  assert.equal(p.quantity, 15);
  assert.equal(p.leverage, 3);
  assert.equal(p.pnl, 15);
  assert.equal(p.pnlPercent, 15);
  assert.equal(p.equity, 115);
  assert.equal(p.buffer, 115 - 15.75);
  assert.ok(p.healthPercent > 80 && p.healthPercent <= 100);
  assert.equal(p.liquidation, 14.5);
  assert.ok(Math.abs(p.distancePercent - ((21 - 14.5) / 21) * 100) < 1e-9);
  assert.equal(p.status, 'Within limits');
});

test('a short measures the distance up to its liquidation price', () => {
  const p = positionView(apiPosition({ sizeE18: e18(-15), liquidationE18: e18(26), pnlUsdg: usdg(-15), equityUsdg: usdg(85) }));
  assert.equal(p.side, 'short');
  assert.equal(p.quantity, 15);
  assert.ok(Math.abs(p.distancePercent - ((26 - 21) / 21) * 100) < 1e-9);
});

test('below maintenance reads as such, and health floors at zero', () => {
  const p = positionView(apiPosition({ equityUsdg: usdg(10), maintenanceUsdg: usdg(15.75), bufferUsdg: usdg(-5.75) }));
  assert.equal(p.status, 'Below maintenance');
  assert.equal(p.healthPercent, 0);
});

test('a low buffer is called out before liquidation', () => {
  const p = positionView(apiPosition({ markE18: e18(15.5), liquidationE18: e18(14.5) }));
  assert.equal(p.status, 'Low buffer');
});

test('a position with no valuation yet (no mark) does not produce NaN', () => {
  const { equityUsdg, maintenanceUsdg, notionalUsdg, pnlUsdg, bufferUsdg, ...bare } = apiPosition({ markE18: '0' });
  const p = positionView(bare);
  for (const v of [p.equity, p.pnl, p.notional, p.healthPercent, p.leverage]) assert.ok(Number.isFinite(v));
  assert.equal(p.distancePercent, null);
});

// Orders and trades as the account route returns them.
const dbOrder = (over = {}) => ({
  nonce: '123456789012345', trader: '0xabc', marketId: `0x${'ab'.repeat(32)}`, symbol: 'USAR', kind: 0, triggerE18: e18(18), triggerAbove: false,
  validAfter: '2026-11-01T00:00:00.000Z', expiry: '2026-11-08T00:00:00.000Z', status: 'open',
  body: { sizeDeltaE18: e18(5), marginUsdg: usdg(30), sizeBps: 0 }, ...over,
});

test('a limit buy order: side from the signed size, margin reserved', () => {
  const o = orderView(dbOrder());
  assert.equal(o.label, 'Limit');
  assert.equal(o.side, 'long');
  assert.equal(o.quantity, 5);
  assert.equal(o.margin, 30);
  assert.equal(o.trigger, 18);
  assert.equal(o.protective, false);
  assert.equal(o.nonceText, '123456789012345');
  assert.equal(orderView(dbOrder({ body: { sizeDeltaE18: `-${e18(5)}`, marginUsdg: usdg(30) } })).side, 'short');
});

test('take-profit and stop-loss are protective, close the whole position and reserve no margin', () => {
  const tp = orderView(dbOrder({ kind: 2, triggerAbove: true, body: { sizeDeltaE18: '0', sizeBps: 10000, marginUsdg: '0' } }));
  assert.equal(tp.protective, true);
  assert.equal(tp.label, 'Take profit');
  assert.equal(tp.side, null);
  assert.equal(tp.quantity, null);
  const sl = orderView(dbOrder({ kind: 3, body: { sizeDeltaE18: '0', sizeBps: 10000, marginUsdg: '0' } }));
  assert.equal(sl.label, 'Stop loss');
  const found = protectionFor('USAR', [tp, sl, orderView(dbOrder())]);
  assert.equal(found.takeProfit, tp);
  assert.equal(found.stopLoss, sl);
  assert.deepEqual(protectionFor('CLSK', [tp, sl]), { takeProfit: null, stopLoss: null });
});

test('trades: side from the sign, labels for each path, liquidations flagged', () => {
  const base = { txHash: '0xhash', logIndex: 0, at: '2026-11-01T12:00:00.000Z', symbol: 'USAR', sizeDeltaE18: e18(-2), priceE18: e18(20), feeUsdg: usdg(0.03), realizedPnlUsdg: usdg(4.5), path: 0 };
  const t = tradeView(base);
  assert.equal(t.side, 'sell');
  assert.equal(t.quantity, 2);
  assert.equal(t.notional, 40);
  assert.equal(t.fee, 0.03);
  assert.equal(t.pnl, 4.5);
  assert.equal(t.path, 'Quote');
  assert.equal(tradeView({ ...base, path: 2 }).path, 'Close at mark');
  assert.equal(tradeView({ ...base, path: 3 }).liquidation, true);
});

test('account totals add up: equity = deposited + margin + pnl; reserved counts entry orders only', () => {
  const state = { collateralUsdg: usdg(50), usdgBalance: usdg(300), vaultShares: '5000000000', vaultSharesValueUsdg: usdg(5), positions: [apiPosition(), apiPosition({ symbol: 'CLSK', pnlUsdg: usdg(-5), marginUsdg: usdg(60), notionalUsdg: usdg(180) })] };
  const orders = [orderView(dbOrder()), orderView(dbOrder({ kind: 3, body: { sizeDeltaE18: '0', sizeBps: 10000, marginUsdg: '0' } }))];
  const a = accountView(state, orders);
  assert.equal(a.collateral, 50);
  assert.equal(a.wallet, 300);
  assert.equal(a.margin, 160);
  assert.equal(a.pnl, 10);
  assert.equal(a.equity, 50 + 160 + 10);
  assert.equal(a.exposure, 495);
  assert.equal(a.reserved, 30);
  assert.equal(a.available, 350);
  assert.equal(a.shares, 5_000_000_000n);
  assert.equal(a.positions.length, 2);
});

test('with no wallet the account is empty, not undefined', () => {
  const a = accountView(null, []);
  assert.equal(a.equity, 0);
  assert.deepEqual(a.positions, []);
});

test('preview: an accepted estimate, and a refusal that keeps its code', () => {
  const ok = previewView({ ok: true, sizeDeltaE18: e18(3), execPriceE18: e18(20.02), feeUsdg: usdg(0.05), notionalUsdg: usdg(60), spreadBps: 5, reducing: false, liquidationE18: e18(14), shortfallUsdg: '0', maxLeverageE18: e18(3) });
  assert.equal(ok.ok, true);
  assert.equal(ok.execPrice, 20.02);
  assert.equal(ok.liquidation, 14);
  assert.equal(ok.maxLeverage, 3);
  assert.equal(ok.sizeDeltaE18, 3n * 10n ** 18n);
  const no = previewView({ ok: false, code: 'no_capacity', message: 'market capacity is used up on this side' });
  assert.deepEqual(no, { ok: false, code: 'no_capacity', message: 'market capacity is used up on this side' });
  assert.equal(previewView(null), null);
  assert.equal(previewView({ ok: true, sizeDeltaE18: '1', execPriceE18: '1', feeUsdg: '0', notionalUsdg: '0', spreadBps: 0, reducing: true, liquidationE18: null, shortfallUsdg: '0', maxLeverageE18: '0' }).liquidation, null);
});

test('relativeTime reads naturally in both directions', () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeTime(now + 30_000, now), 'in 30s');
  assert.equal(relativeTime(now - 30_000, now), '30s ago');
  assert.equal(relativeTime(now - 3 * 60_000, now), '3m ago');
  assert.equal(relativeTime(now + 3 * 3_600_000, now), 'in 3h');
  assert.equal(relativeTime(now + 7 * 86_400_000, now), 'in 7d');
});

test('a price that is still warming up cannot open a position, and says so', () => {
  const m = marketView(apiMarket({ mark: { ...apiMarket().mark, reason: 'warming up 3/20', confidenceBps: 9999 } }));
  assert.equal(m.warming, true);
  assert.equal(m.canOpen, false);
  assert.match(m.blockers[0], /warming up \(3\/20/);
  assert.equal(marketView(apiMarket()).warming, false);
});
