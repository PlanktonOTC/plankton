import { BPS, abs, bpsOf, diffBps, notionalUsdg as notionalOf, usdgToE18 } from './units.ts';
import { MarketState, Status, type MarketClass } from './types.ts';
import { OPEN_GUARD_EXTRA_SPREAD_BPS, type SessionProfileCfg } from './sessions.ts';
import { capacity, netOf, skewFillPriceE18, tradeFeeUsdg, type MarketCaps, type OpenInterest } from './risk.ts';

export interface QuoteMarket {
  class: MarketClass;
  state: MarketState;
  feeBps: number;
  maxExecDeviationBps: number;
  /** Opens revert above this confidence width. */
  maxConfidenceBps: number;
  frozenSpreadBps: number;
  skewScaleE18: bigint;
  caps: MarketCaps;
  oi: OpenInterest;
  /** Remaining all-markets net budget in USDG; undefined = not enforced here. */
  globalNetRoomUsdg?: bigint;
  /** Leverage ceiling from the current Counter rung. */
  leverageCap: number;
  /** Counter NAV in USDG; used for per-wallet limits. */
  navUsdg: bigint;
  /** Counter is in deleverage mode: opens blocked. */
  deleveraging: boolean;
}

export interface QuoteMark {
  priceE18: bigint;
  confidenceBps: number;
  status: Status;
  sequence: bigint;
  ageSec: number;
  breaker: boolean;
}

export interface QuoteRequest {
  /** Signed size change in token units, E18. Positive = buy. */
  sizeDeltaE18: bigint;
  marginUsdg: bigint;
  /** Margin already in the position, USDG. Counts toward leverage when the trade adds to the same side. */
  existingMarginUsdg?: bigint;
  /** Current signed position size, E18 (0 when flat). */
  positionSizeE18: bigint;
  openGuard: boolean;
  /** Extra spread while the open guard runs; defaults to OPEN_GUARD_EXTRA_SPREAD_BPS. Never below the contract's. */
  openGuardSpreadBps?: number;
  /** Source-aware minimum spread for a new/increased position. */
  minOpenSpreadBps?: number;
  /** Ticket limit (bps of V) while the open guard runs; undefined = no extra limit. */
  openGuardPositionBpsOfV?: number;
  profile: SessionProfileCfg;
  /** Sum of the wallet's open notionals across markets, for per-wallet (weekend) limits. */
  walletNotionalUsdg?: bigint;
  maxMarkAgeSec?: number;
}

export type QuoteFailure =
  | 'market_not_active'
  | 'session_closed'
  | 'breaker_set'
  | 'stale_mark'
  | 'low_confidence'
  | 'zero_size'
  | 'margin_required'
  | 'leverage_exceeded'
  | 'position_too_large'
  | 'wallet_limit'
  | 'no_capacity'
  | 'deleveraging'
  | 'exec_deviation'
  | 'unknown_market';

export type QuoteResult =
  | {
      ok: true;
      execPriceE18: bigint;
      feeUsdg: bigint;
      notionalUsdg: bigint;
      maxLeverageE18: bigint;
      reducing: boolean;
      spreadBps: number;
    }
  | { ok: false; code: QuoteFailure; message: string };

const fail = (code: QuoteFailure, message: string): QuoteResult => ({ ok: false, code, message });

/** A trade is risk-reducing when it only moves the position toward flat. Flips are not reducing. */
export function isRiskReducing(positionSizeE18: bigint, sizeDeltaE18: bigint): boolean {
  if (positionSizeE18 === 0n || sizeDeltaE18 === 0n) return false;
  if ((positionSizeE18 > 0n) === (sizeDeltaE18 > 0n)) return false;
  return abs(sizeDeltaE18) <= abs(positionSizeE18);
}

export function buildTradeQuote(m: QuoteMarket, mark: QuoteMark, r: QuoteRequest): QuoteResult {
  if (r.sizeDeltaE18 === 0n) return fail('zero_size', 'size must be non-zero');
  const reducing = isRiskReducing(r.positionSizeE18, r.sizeDeltaE18);
  const buy = r.sizeDeltaE18 > 0n;
  const tradeNotionalUsdg = notionalOf(r.sizeDeltaE18, mark.priceE18);

  // Spread, exactly as the contract charges it: closes pay only the frozen spread, and only in a frozen, halted or
  // close-only market; opens pay the session profile's spread plus the open guard's.
  let spreadBps: number;
  if (reducing) {
    const frozen = mark.status === Status.Frozen || mark.status === Status.Halted || m.state !== MarketState.Active;
    spreadBps = frozen ? m.frozenSpreadBps : 0;
  } else {
    spreadBps = Math.max(r.profile.extraSpreadBps, r.minOpenSpreadBps ?? 0) + (r.openGuard ? (r.openGuardSpreadBps ?? OPEN_GUARD_EXTRA_SPREAD_BPS) : 0);
  }

  if (!reducing) {
    if (m.state !== MarketState.Active) return fail('market_not_active', 'market is close-only or paused');
    if (!r.profile.opensAllowed) return fail('session_closed', 'opens are not allowed in this session');
    if (m.deleveraging) return fail('deleveraging', 'Counter is deleveraging: opens are stopped');
    if (mark.breaker) return fail('breaker_set', 'price breaker is set: opens are stopped');
    if (r.maxMarkAgeSec !== undefined && mark.ageSec > r.maxMarkAgeSec) return fail('stale_mark', 'mark is too old');
    if (mark.confidenceBps > m.maxConfidenceBps) return fail('low_confidence', 'mark confidence is too low for opens');
    if (r.marginUsdg <= 0n) return fail('margin_required', 'margin is required to open');

    const newSize = r.positionSizeE18 + r.sizeDeltaE18;
    const newNotional = notionalOf(newSize, mark.priceE18);
    const levCap = Math.min(r.profile.leverage[m.class], m.leverageCap);
    if (levCap <= 0) return fail('session_closed', 'no leverage available in this session');
    // Adding to the same side keeps the existing margin; a flip releases it and starts fresh.
    const sameSide = r.positionSizeE18 !== 0n && r.positionSizeE18 > 0n === r.sizeDeltaE18 > 0n;
    const totalMargin = sameSide ? r.marginUsdg + (r.existingMarginUsdg ?? 0n) : r.marginUsdg;
    // leverage <= cap  <=>  notional * 1000 <= margin * cap * 1000 (3 decimal places of cap)
    if (newNotional * 1000n > totalMargin * BigInt(Math.round(levCap * 1000))) {
      return fail('leverage_exceeded', `max leverage is ${levCap}x`);
    }

    let posCapUsdg = r.profile.perWallet ? bpsOf(m.navUsdg, r.profile.maxPositionBpsOfV) : min2(m.caps.positionUsdg, bpsOf(m.navUsdg, r.profile.maxPositionBpsOfV));
    if (r.openGuard && r.openGuardPositionBpsOfV !== undefined && !r.profile.perWallet) {
      posCapUsdg = min2(posCapUsdg, bpsOf(m.navUsdg, r.openGuardPositionBpsOfV));
    }
    if (r.profile.perWallet) {
      if ((r.walletNotionalUsdg ?? 0n) + tradeNotionalUsdg > posCapUsdg) return fail('wallet_limit', 'weekend per-wallet allowance reached');
    } else if (newNotional > posCapUsdg) {
      return fail('position_too_large', 'position exceeds the single-position cap');
    }

    const room = capacity(m.oi, m.caps, m.globalNetRoomUsdg);
    if (tradeNotionalUsdg > (buy ? room.longRoomUsdg : room.shortRoomUsdg)) {
      return fail('no_capacity', 'market capacity is used up on this side');
    }
  }

  const skewBefore = usdgToE18(netOf(m.oi));
  const signedNotionalE18 = usdgToE18(tradeNotionalUsdg) * (buy ? 1n : -1n);
  const base = skewFillPriceE18(mark.priceE18, skewBefore, skewBefore + signedNotionalE18, m.skewScaleE18);
  const execPriceE18 = (base * (BPS + BigInt(buy ? spreadBps : -spreadBps))) / BPS;

  // The contract allows the normal deviation plus whatever spread it charges.
  const bound = BigInt(m.maxExecDeviationBps + spreadBps);
  if (diffBps(execPriceE18, mark.priceE18) > bound) return fail('exec_deviation', 'execution price too far from mark');

  const notionalUsdg = notionalOf(r.sizeDeltaE18, execPriceE18);
  return {
    ok: true,
    execPriceE18,
    feeUsdg: tradeFeeUsdg(notionalUsdg, m.feeBps),
    notionalUsdg,
    maxLeverageE18: BigInt(Math.round(Math.min(r.profile.leverage[m.class], m.leverageCap) * 1e6)) * 10n ** 12n,
    reducing,
    spreadBps,
  };
}

const min2 = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Size in token units (E18) for a close of `bps` of the position. */
export function closeSizeDeltaE18(positionSizeE18: bigint, bps: number): bigint {
  const portion = (abs(positionSizeE18) * BigInt(Math.min(Math.max(bps, 0), 10_000))) / BPS;
  return positionSizeE18 > 0n ? -portion : portion;
}
