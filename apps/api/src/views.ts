import { E18, USDG_SCALE, abs, e18ToUsdg, sizeFromNotionalE18, type QuoteResult } from '@plankton/core';

// Pure helpers behind the website's read routes: what a position is worth, where it liquidates, and how big a trade
// to ask the quote builder for. Nothing here touches the chain or the network.

export interface PositionLike {
  /** Signed size in token units, E18. */
  sizeE18: bigint;
  entryE18: bigint;
  marginUsdg: bigint;
}

export interface PositionValue {
  notionalUsdg: bigint;
  pnlUsdg: bigint;
  equityUsdg: bigint;
  maintenanceUsdg: bigint;
  /** Equity left above the maintenance requirement. Negative means liquidatable. */
  bufferUsdg: bigint;
}

/** Value of a position at a mark. Borrow accrued since opening is not included: the chain settles it. */
export function positionValue(p: PositionLike, markE18: bigint, maintenanceMarginBps: number): PositionValue {
  const notional = e18ToUsdg((abs(p.sizeE18) * markE18) / E18);
  const pnl = e18ToUsdg((p.sizeE18 * (markE18 - p.entryE18)) / E18);
  const equity = p.marginUsdg + pnl;
  const maintenance = (notional * BigInt(maintenanceMarginBps)) / 10_000n;
  return { notionalUsdg: notional, pnlUsdg: pnl, equityUsdg: equity, maintenanceUsdg: maintenance, bufferUsdg: equity - maintenance };
}

/**
 * The mark at which equity falls to the maintenance requirement. Solves
 *   margin + size * (L - entry) = maintenance * |size| * L
 * for L. Null for a flat position. Floors at zero (a long that cannot be liquidated by price falling).
 */
export function liquidationPriceE18(p: PositionLike, maintenanceMarginBps: number): bigint | null {
  if (p.sizeE18 === 0n) return null;
  const size = abs(p.sizeE18);
  const marginE18 = p.marginUsdg * USDG_SCALE;
  const mm = BigInt(maintenanceMarginBps);
  if (p.sizeE18 > 0n) {
    const num = (size * p.entryE18 - marginE18 * E18) * 10_000n;
    if (num <= 0n) return 0n;
    return num / (size * (10_000n - mm));
  }
  return ((size * p.entryE18 + marginE18 * E18) * 10_000n) / (size * (10_000n + mm));
}

/** The position that results from adding to a flat or same-side position, for a pre-trade liquidation estimate. */
export function positionAfterOpen(current: PositionLike, sizeDeltaE18: bigint, execPriceE18: bigint, addedMarginUsdg: bigint): PositionLike | null {
  if (sizeDeltaE18 === 0n) return null;
  if (current.sizeE18 === 0n) return { sizeE18: sizeDeltaE18, entryE18: execPriceE18, marginUsdg: addedMarginUsdg };
  const sameSide = current.sizeE18 > 0n === sizeDeltaE18 > 0n;
  if (!sameSide) return null; // a reduce or a flip: the chain decides what margin is released
  const total = current.sizeE18 + sizeDeltaE18;
  const entry = (abs(current.sizeE18) * current.entryE18 + abs(sizeDeltaE18) * execPriceE18) / abs(total);
  return { sizeE18: total, entryE18: entry, marginUsdg: current.marginUsdg + addedMarginUsdg };
}

/** One try at a size: the verdict, plus the price it would fill at when that is known even for a refusal. */
export interface QuoteAttempt {
  result: QuoteResult;
  execPriceE18?: bigint;
}

/**
 * Finds the largest signed size that stays within the target notional at BOTH the mark and the execution price (mark plus
 * skew impact and spread). The quote builder checks leverage at the mark and the contract checks it at the fill price, so a
 * long (which fills above the mark) is held by the fill price and a short (which fills below it) by the mark. The first
 * guess uses the mark, a refusal for leverage at the fill price is corrected from that price, and a few passes settle it.
 * Returns the best accepted attempt, or the last refusal when none was accepted.
 */
export function solveOpenSize(
  quote: (sizeDeltaE18: bigint) => QuoteAttempt,
  side: 'long' | 'short',
  targetNotionalUsdg: bigint,
  markE18: bigint,
): { sizeDeltaE18: bigint; result: QuoteResult } {
  const sign = side === 'long' ? 1n : -1n;
  let size = sizeFromNotionalE18(targetNotionalUsdg, markE18) * sign;
  let best: { sizeDeltaE18: bigint; result: QuoteResult } | null = null;
  let last: { sizeDeltaE18: bigint; result: QuoteResult } = { sizeDeltaE18: size, result: { ok: false, code: 'zero_size', message: 'no size tried' } };
  for (let pass = 0; pass < 4; pass++) {
    const attempt = quote(size);
    last = { sizeDeltaE18: size, result: attempt.result };
    if (attempt.result.ok) best = last;
    const price = attempt.result.ok ? attempt.result.execPriceE18 : attempt.execPriceE18;
    if (price === undefined) break; // refused for a reason a different size cannot fix
    const reference = price > markE18 ? price : markE18;
    const next = sizeFromNotionalE18(targetNotionalUsdg, reference) * sign;
    if (next === size) break; // settled
    size = next;
  }
  return best ?? last;
}

/** Notional for a margin and a leverage given as a decimal string ("2.5"), shaved one basis point so exactly-max passes. */
export function targetNotional(marginUsdg: bigint, leverage: string): bigint {
  const [whole = '0', frac = ''] = leverage.split('.');
  const milli = BigInt(whole) * 1000n + BigInt(frac.padEnd(3, '0').slice(0, 3));
  return (((marginUsdg * milli) / 1000n) * 9_999n) / 10_000n;
}

/** What the signed-quote path needs beyond the trader's deposited collateral, and whether a permit covers it. */
export function collateralShortfall(marginUsdg: bigint, feeUsdg: bigint, reducing: boolean, collateralUsdg: bigint): bigint {
  const needed = (reducing ? 0n : marginUsdg) + feeUsdg;
  return needed > collateralUsdg ? needed - collateralUsdg : 0n;
}
