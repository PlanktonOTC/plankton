import { BPS, E18, abs, bpsOf, clamp0, e18ToUsdg, min, usdgToE18 } from './units.ts';
import type { MarketClass } from './types.ts';

// --- cap ladder (Overview section 7.1) ---

export type Rung = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export interface RungParams {
  netSkewBps: number;
  grossOiBps: number;
  positionBps: number;
  totalNetBps: number;
  maxMarkets: number;
  /** Leverage ceiling by class at this rung. */
  leverage: Record<MarketClass, number>;
}

export const RUNGS: Record<Rung, RungParams> = {
  R0: { netSkewBps: 400, grossOiBps: 1_200, positionBps: 100, totalNetBps: 2_000, maxMarkets: 4, leverage: { micro: 2, small: 3, smid: 3, index: 3 } },
  R1: { netSkewBps: 400, grossOiBps: 1_200, positionBps: 100, totalNetBps: 2_000, maxMarkets: 8, leverage: { micro: 3, small: 3, smid: 5, index: 5 } },
  R2: { netSkewBps: 400, grossOiBps: 1_200, positionBps: 100, totalNetBps: 2_000, maxMarkets: 12, leverage: { micro: 3, small: 3, smid: 5, index: 5 } },
  R3: { netSkewBps: 500, grossOiBps: 1_500, positionBps: 150, totalNetBps: 2_000, maxMarkets: 24, leverage: { micro: 3, small: 3, smid: 5, index: 5 } },
  R4: { netSkewBps: 500, grossOiBps: 1_500, positionBps: 150, totalNetBps: 2_000, maxMarkets: 64, leverage: { micro: 3, small: 3, smid: 5, index: 5 } },
};

/** Net skew cap as bps of V from a gap budget: 2% V budget / 50% stress gap = 4% V. */
export const netSkewBpsFromBudget = (gapBudgetBps: number, stressGapBps: number): number =>
  Math.floor((gapBudgetBps * 10_000) / stressGapBps);

export interface MarketCaps {
  netSkewUsdg: bigint;
  grossOiUsdg: bigint;
  positionUsdg: bigint;
  totalNetUsdg: bigint;
}

/** V is Counter NAV in USDG. absOiCapUsdg is 1% of the underlying's 20-day dollar ADV, written daily. */
export function marketCaps(navUsdg: bigint, p: RungParams, absOiCapUsdg?: bigint): MarketCaps {
  const gross = bpsOf(navUsdg, p.grossOiBps);
  return {
    netSkewUsdg: bpsOf(navUsdg, p.netSkewBps),
    grossOiUsdg: absOiCapUsdg && absOiCapUsdg > 0n ? min(gross, absOiCapUsdg) : gross,
    positionUsdg: bpsOf(navUsdg, p.positionBps),
    totalNetUsdg: bpsOf(navUsdg, p.totalNetBps),
  };
}

export interface OpenInterest {
  longUsdg: bigint;
  shortUsdg: bigint;
}

export const netOf = (oi: OpenInterest): bigint => oi.longUsdg - oi.shortUsdg;
export const grossOf = (oi: OpenInterest): bigint => oi.longUsdg + oi.shortUsdg;

/** Largest notional that can still be added on each side without breaching net skew, gross OI or position caps. */
export function capacity(oi: OpenInterest, caps: MarketCaps, globalNetRoomUsdg?: bigint): { longRoomUsdg: bigint; shortRoomUsdg: bigint } {
  const net = netOf(oi);
  const grossRoom = clamp0(caps.grossOiUsdg - grossOf(oi));
  let longRoom = min(clamp0(caps.netSkewUsdg - net), grossRoom);
  let shortRoom = min(clamp0(caps.netSkewUsdg + net), grossRoom);
  if (globalNetRoomUsdg !== undefined) {
    // A trade against the current net first shrinks it for free, then adds to the all-markets total.
    longRoom = min(longRoom, clamp0(globalNetRoomUsdg + (net < 0n ? -net : 0n)));
    shortRoom = min(shortRoom, clamp0(globalNetRoomUsdg + (net > 0n ? net : 0n)));
  }
  return { longRoomUsdg: longRoom, shortRoomUsdg: shortRoom };
}

// --- skew impact (SIP-279 style) ---

export const DEFAULT_SKEW_IMPACT_AT_CAP_BPS = 75;

/** skewScale such that a trade taking the market from flat to its net cap pays targetImpactBps on average. Returns E18 USD. */
export function skewScaleE18(netSkewCapUsdg: bigint, targetImpactBps = DEFAULT_SKEW_IMPACT_AT_CAP_BPS): bigint {
  return (usdgToE18(netSkewCapUsdg) * BPS) / (2n * BigInt(targetImpactBps));
}

/** fill = mark * (1 + (skewBefore + skewAfter) / 2 / skewScale). Skew is long notional minus short notional, E18 USD. */
export function skewFillPriceE18(markE18: bigint, skewBeforeE18: bigint, skewAfterE18: bigint, scaleE18: bigint): bigint {
  if (scaleE18 <= 0n) return markE18;
  const impactE18 = ((skewBeforeE18 + skewAfterE18) / 2n) * E18 / scaleE18;
  return (markE18 * (E18 + impactE18)) / E18;
}

// --- borrow ---

/** Dominant side pays base * (net / maxNet)^2 per hour, in bps/hour. For display; the contract is the source of truth. */
export function dominantBorrowBpsPerHour(baseBps: number, netUsdg: bigint, maxNetUsdg: bigint): number {
  if (maxNetUsdg <= 0n) return 0;
  const r = Number(abs(netUsdg)) / Number(maxNetUsdg);
  return baseBps * Math.min(r, 1) ** 2;
}

/** Both sides pay at least `base` once gross OI passes 80% of its cap (the M-2 fix). */
export const minimumBorrowApplies = (grossUsdg: bigint, grossCapUsdg: bigint): boolean => grossUsdg * 10n > grossCapUsdg * 8n;

// --- fees ---

export const DEFAULT_FEE_BPS: Record<MarketClass, number> = { micro: 12, small: 8, smid: 8, index: 8 };

export const tradeFeeUsdg = (notionalUsdg: bigint, feeBps: number): bigint => bpsOf(notionalUsdg, feeBps);

export type FeePhase = 'v1' | 'v2';
export interface FeeSplit {
  referralUsdg: bigint;
  counterUsdg: bigint;
  backstopUsdg: bigint;
  juniorUsdg: bigint;
  treasuryUsdg: bigint;
}

/**
 * Referral rebate (0-10%) first, then:
 * v1 counter 75 / backstop 20 / treasury 5; v2 counter 65 / backstop 10 / junior 15 / treasury 10.
 * Once the Backstop Fund holds 10% of V its share goes to the Counter.
 */
export function splitFee(feeUsdg: bigint, phase: FeePhase, opts: { referralBps?: number; backstopAtTarget?: boolean } = {}): FeeSplit {
  const referralBps = Math.min(Math.max(opts.referralBps ?? 0, 0), 1_000);
  const referralUsdg = bpsOf(feeUsdg, referralBps);
  const net = feeUsdg - referralUsdg;
  const shares = phase === 'v1' ? { backstop: 2_000, junior: 0, treasury: 500 } : { backstop: 1_000, junior: 1_500, treasury: 1_000 };
  let backstopUsdg = bpsOf(net, shares.backstop);
  const juniorUsdg = bpsOf(net, shares.junior);
  const treasuryUsdg = bpsOf(net, shares.treasury);
  if (opts.backstopAtTarget) backstopUsdg = 0n;
  const counterUsdg = net - backstopUsdg - juniorUsdg - treasuryUsdg;
  return { referralUsdg, counterUsdg, backstopUsdg, juniorUsdg, treasuryUsdg };
}

// --- liquidation ---

export interface PositionView {
  /** Signed size in token units, E18. */
  sizeE18: bigint;
  entryE18: bigint;
  marginUsdg: bigint;
}

export const unrealizedPnlUsdg = (p: PositionView, markE18: bigint): bigint => e18ToUsdg((p.sizeE18 * (markE18 - p.entryE18)) / E18);

export interface LiquidationParams {
  maintenanceMarginBps: number;
  /** Borrow accrued since open, USDG. The chain is authoritative; callers pass an estimate or 0. */
  accruedBorrowUsdg?: bigint;
}

export function equityUsdg(p: PositionView, markE18: bigint, accruedBorrowUsdg = 0n): bigint {
  return p.marginUsdg + unrealizedPnlUsdg(p, markE18) - accruedBorrowUsdg;
}

export function isLiquidatable(p: PositionView, markE18: bigint, lp: LiquidationParams): boolean {
  if (p.sizeE18 === 0n) return false;
  const notional = e18ToUsdg((abs(p.sizeE18) * markE18) / E18);
  return equityUsdg(p, markE18, lp.accruedBorrowUsdg ?? 0n) < bpsOf(notional, lp.maintenanceMarginBps);
}

/** Penalty is 5% of margin: 2.5% to the liquidator, 2.5% to the Backstop Fund. */
export function liquidationPenalty(marginUsdg: bigint): { liquidatorUsdg: bigint; backstopUsdg: bigint; totalUsdg: bigint } {
  const liquidatorUsdg = bpsOf(marginUsdg, 250);
  const backstopUsdg = bpsOf(marginUsdg, 250);
  return { liquidatorUsdg, backstopUsdg, totalUsdg: liquidatorUsdg + backstopUsdg };
}

// --- payout limits ---

/** Realised trader profit above this per rolling hour goes through the payout desk. */
export const hourlyProfitLimitUsdg = (navUsdg: bigint): bigint => bpsOf(navUsdg, 200);
/** A profitable reduce inside minHoldSec has its profit capped at 25 bp of notional. */
export const minHoldProfitCapUsdg = (notionalUsdg: bigint): bigint => bpsOf(notionalUsdg, 25);

// --- stress ---

/** NAV after every market gaps `gapBps` against the Counter on its net side. */
export function stressNavUsdg(navUsdg: bigint, netByMarketUsdg: bigint[], gapBps = 2_500): { stressNavUsdg: bigint; lossUsdg: bigint } {
  let exposure = 0n;
  for (const n of netByMarketUsdg) exposure += abs(n);
  const lossUsdg = bpsOf(exposure, gapBps);
  return { stressNavUsdg: navUsdg - lossUsdg, lossUsdg };
}

/** Deleverage mode when a withdrawal has waited past the hard maximum: opens stop and caps halve. */
export const WITHDRAW_HARD_MAX_SEC = 72 * 3_600;
export const isDeleveraging = (oldestPendingWithdrawAgeSec: number): boolean => oldestPendingWithdrawAgeSec > WITHDRAW_HARD_MAX_SEC;
export function halveCaps(c: MarketCaps): MarketCaps {
  return { netSkewUsdg: c.netSkewUsdg / 2n, grossOiUsdg: c.grossOiUsdg / 2n, positionUsdg: c.positionUsdg / 2n, totalNetUsdg: c.totalNetUsdg / 2n };
}
