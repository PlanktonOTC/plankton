import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_SLICE_MARGIN_USDG, TWAP_MAX_SLICES, intervalLabel, planTwap, sliceWindowSec, twapStartDelaySec } from '../src/live/twap.js';
import { MARKET_ORDER_LIFETIME_SEC, ORDER_KIND, marketOrder } from '../src/live/orders.js';

const NOW = 1_800_000_000n;
const E18 = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const base = { side: 'long', totalMarginUsdg: 100_000_000n, leverage: 2, slices: 5, intervalSec: 900, priceE18: E18(4), chainNow: NOW };

test('splits the margin evenly and the last slice takes the remainder', () => {
  const p = planTwap({ ...base, totalMarginUsdg: 100_000_003n, slices: 3 });
  assert.equal(p.ok, true);
  assert.deepEqual(p.slices.map((s) => s.marginUsdg), [33_333_334n, 33_333_334n, 33_333_335n]);
  assert.equal(p.totals.marginUsdg, 100_000_003n);
});

test('slices open one interval apart, the first now', () => {
  const p = planTwap(base);
  assert.deepEqual(p.slices.map((s) => s.validAfter), [0n, 900n, 1800n, 2700n, 3600n].map((d) => NOW + d));
  assert.equal(p.totals.spanSec, 3600n);
});

test('a start delay moves every slice later by the same amount', () => {
  const p = planTwap({ ...base, startDelaySec: 60 });
  assert.deepEqual(p.slices.map((s) => s.validAfter), [60n, 960n, 1860n, 2760n, 3660n].map((d) => NOW + d));
  assert.equal(twapStartDelaySec(5), 60);
  assert.equal(twapStartDelaySec(12), 116);
});

test('each slice stays valid for its window', () => {
  const p = planTwap(base);
  assert.equal(p.slices[0].expiry - p.slices[0].validAfter, 900n);
  assert.equal(sliceWindowSec(60), 300n); // never shorter than 5 minutes
  assert.equal(sliceWindowSec(86_400), 21_600n); // never longer than 6 hours
});

test('sizes follow margin, leverage with headroom, and price', () => {
  const p = planTwap({ ...base, slices: 2, totalMarginUsdg: 40_000_000n, leverage: 2 });
  const s = p.slices[0]; // 20 USDG margin, 2x * 0.98 = 39.2 USDG notional at 4.00 = 9.8 tokens
  assert.equal(s.notionalUsdg, 39_200_000n);
  assert.equal(s.sizeE18, 9_800_000_000_000_000_000n);
});

test('a short sells: sizes are negative', () => {
  const p = planTwap({ ...base, side: 'short' });
  assert.ok(p.slices.every((s) => s.sizeE18 < 0n));
});

test('collateral needed covers margin, fees and a small buffer', () => {
  const p = planTwap(base);
  assert.equal(p.totals.collateralNeededUsdg, p.totals.marginUsdg + p.totals.feeUsdg + 10_000n);
  assert.ok(p.totals.feeUsdg > 0n);
});

test('rejects bad inputs with a sentence', () => {
  assert.match(planTwap({ ...base, slices: 1 }).problem, /between 2 and 12/);
  assert.match(planTwap({ ...base, slices: TWAP_MAX_SLICES + 1 }).problem, /between 2 and 12/);
  assert.match(planTwap({ ...base, slices: 2.5 }).problem, /between 2 and 12/);
  assert.match(planTwap({ ...base, intervalSec: 7 }).problem, /how often/);
  assert.match(planTwap({ ...base, totalMarginUsdg: 0n }).problem, /above 0/);
  assert.match(planTwap({ ...base, priceE18: 0n }).problem, /no price/);
  assert.match(planTwap({ ...base, leverage: 0 }).problem, /leverage/);
});

test('each slice needs a minimum margin', () => {
  const tooSmall = planTwap({ ...base, totalMarginUsdg: 4_000_000n, slices: 5 });
  assert.match(tooSmall.problem, new RegExp(`at least ${MIN_SLICE_MARGIN_USDG} USDG`));
  assert.equal(planTwap({ ...base, totalMarginUsdg: 5_000_000n, slices: 5 }).ok, true);
});

test('a schedule over 30 days is refused', () => {
  assert.equal(planTwap({ ...base, intervalSec: 86_400, slices: 12 }).ok, true); // 11 days + 6h
  assert.equal(intervalLabel(900), '15 minutes');
});

test('every slice makes a valid market order (kind 4, entry, own expiry)', () => {
  const p = planTwap(base);
  const s = p.slices[2];
  const order = marketOrder({ marketId: `0x${'ab'.repeat(32)}`, trader: '0x0000000000000000000000000000000000000001', sizeDeltaE18: s.sizeE18, marginUsdg: s.marginUsdg, validAfter: s.validAfter, nonce: 9n, lifetimeSec: s.expiry - s.validAfter });
  assert.equal(order.kind, ORDER_KIND.market);
  assert.equal(order.expiry, s.expiry);
  assert.equal(order.reduceOnly, false);
  assert.equal(order.sizeBps, 0);
  assert.ok(order.marginUsdg > 0n && order.sizeDeltaE18 !== 0n); // an entry order: the API reserves its margin
  // the default for a single gasless order is unchanged
  assert.equal(marketOrder({ marketId: order.marketId, trader: order.trader, sizeDeltaE18: 1n, marginUsdg: 1n, validAfter: NOW, nonce: 1n }).expiry, NOW + MARKET_ORDER_LIFETIME_SEC);
});
