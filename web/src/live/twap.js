// TWAP / DCA: buy (or sell short) gradually. One total is split into equal slices, and each slice is its own signed market
// order that becomes valid at its own time. The keeper already waits for an order's validAfter and fills it then, so this
// needs no contract or backend change. All slices are signed now; the trader's browser can be closed afterwards.

export const TWAP_MIN_SLICES = 2;
export const TWAP_MAX_SLICES = 12; // each slice is one wallet signature, and an account holds at most 50 open orders
export const TWAP_INTERVALS = [
  [60, '1 minute'],
  [300, '5 minutes'],
  [900, '15 minutes'],
  [3600, '1 hour'],
  [14_400, '4 hours'],
  [86_400, '1 day'],
];
/** Margin below this per slice is not worth a keeper transaction. */
export const MIN_SLICE_MARGIN_USDG = 1;
const MIN_WINDOW_SEC = 300n;
const MAX_WINDOW_SEC = 21_600n;
const MAX_SPAN_SEC = 30n * 86_400n; // the API refuses an order that expires more than 30 days out
/** Slices are sized a little under the leverage limit: the fill price differs slightly from the price used here. */
export const SLICE_LEVERAGE_HEADROOM = 0.98;
const FEE_BUFFER_USDG = 10_000n; // 0.01 USDG of collateral kept spare for fee ticks

/**
 * How long one slice stays valid once it opens. A slice that cannot fill in its window (the market is closed or frozen) is
 * skipped, never filled later at a surprise price, so the window is the time the keeper gets to find it a market.
 */
export const sliceWindowSec = (intervalSec) => {
  const i = BigInt(intervalSec);
  return i < MIN_WINDOW_SEC ? MIN_WINDOW_SEC : i > MAX_WINDOW_SEC ? MAX_WINDOW_SEC : i;
};

/** Signing takes the trader a few seconds per slice, so the first slice opens after a short delay that grows with the slice count. */
export const twapStartDelaySec = (slices) => 20 + 8 * slices;

export const intervalLabel = (sec) => TWAP_INTERVALS.find(([s]) => s === Number(sec))?.[1] ?? `${sec}s`;

/**
 * Plans the slices. Money is bigint USDG (6 decimals); `priceE18` is the price used to size every slice (the sizes are fixed at
 * signing, the price at each fill is whatever the quote gives, within the order's slippage limit).
 * Returns { ok:true, slices, totals } or { ok:false, problem }.
 */
export function planTwap({ side, totalMarginUsdg, leverage, slices, intervalSec, priceE18, chainNow, feeBps = 8, startDelaySec = 0 }) {
  if (!Number.isInteger(slices) || slices < TWAP_MIN_SLICES || slices > TWAP_MAX_SLICES) return { ok: false, problem: `Use between ${TWAP_MIN_SLICES} and ${TWAP_MAX_SLICES} slices.` };
  if (!TWAP_INTERVALS.some(([s]) => s === Number(intervalSec))) return { ok: false, problem: 'Choose how often a slice runs.' };
  if (typeof totalMarginUsdg !== 'bigint' || totalMarginUsdg <= 0n) return { ok: false, problem: 'Enter a margin above 0 USDG.' };
  if (!(priceE18 > 0n)) return { ok: false, problem: 'This market has no price yet.' };
  if (!(leverage > 0)) return { ok: false, problem: 'Choose a leverage above 0.' };

  const n = BigInt(slices);
  const base = totalMarginUsdg / n;
  if (base < BigInt(MIN_SLICE_MARGIN_USDG) * 1_000_000n) return { ok: false, problem: `Each slice needs at least ${MIN_SLICE_MARGIN_USDG} USDG of margin. Use fewer slices or more margin.` };
  const interval = BigInt(intervalSec);
  const window = sliceWindowSec(intervalSec);
  if ((n - 1n) * interval + window > MAX_SPAN_SEC) return { ok: false, problem: 'The schedule would run longer than 30 days.' };

  const lev = BigInt(Math.round(leverage * SLICE_LEVERAGE_HEADROOM * 1000));
  const out = [];
  let marginSum = 0n;
  let feeSum = 0n;
  let notionalSum = 0n;
  for (let i = 0n; i < n; i++) {
    const margin = i === n - 1n ? totalMarginUsdg - base * (n - 1n) : base; // the last slice takes the rounding remainder
    const notional = (margin * lev) / 1000n;
    const sizeE18 = (notional * 10n ** 30n) / priceE18; // USDG (6 dp) * 1e30 / price (E18) = size in E18
    if (sizeE18 <= 0n) return { ok: false, problem: 'That is too small to buy at this price.' };
    const validAfter = chainNow + BigInt(startDelaySec) + i * interval;
    const fee = (notional * BigInt(feeBps)) / 10_000n;
    out.push({ index: Number(i) + 1, marginUsdg: margin, notionalUsdg: notional, sizeE18: side === 'long' ? sizeE18 : -sizeE18, feeUsdg: fee, validAfter, expiry: validAfter + window });
    marginSum += margin;
    feeSum += fee;
    notionalSum += notional;
  }
  return {
    ok: true,
    slices: out,
    totals: {
      marginUsdg: marginSum,
      notionalUsdg: notionalSum,
      feeUsdg: feeSum,
      // The API reserves each slice's margin; the keeper also needs the fee in collateral at the fill.
      collateralNeededUsdg: marginSum + feeSum + FEE_BUFFER_USDG,
      spanSec: (n - 1n) * interval,
    },
  };
}
