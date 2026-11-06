import {
  RUNGS,
  Status,
  buildTradeQuote,
  capacity,
  marketCaps,
  notionalUsdg,
  sessionAt,
  type Calendar,
  type MarketClass,
  type MarketState,
  type QuoteMark,
  type QuoteMarket,
  type QuoteRequest,
  type QuoteResult,
  type Rung,
  type SessionProfileCfg,
  OPEN_GUARD_EXTRA_SPREAD_BPS,
} from '@plankton/core';
import type { MarketSnapshot, TraderSnapshot } from '@plankton/chain';

const E18 = 10n ** 18n;
const TOTAL_NET_BPS = 2_000n; // all-markets net exposure: 20% of V, same as the contract

export interface ChainQuoteInput {
  snap: MarketSnapshot;
  trader: TraderSnapshot;
  cls: MarketClass;
  rung: Rung;
  sizeDeltaE18: bigint;
  marginUsdg: bigint;
  nowMs: number;
  calendar: Calendar;
  windowTz: string;
  minOpenSpreadBps?: number;
}

export interface ChainQuote {
  result: QuoteResult;
  /** The leverage ceiling written into the signed quote (never above the on-chain profile). */
  maxLeverageE18: bigint;
  /** The price the trade would fill at, set even when the leverage re-check refuses it, so a caller can resize. */
  execPriceE18?: bigint;
}

const LIQUIDATION_BY_STATUS = ['none', 'two_source', 'two_source', 'margin_only', 'none', 'none'] as const;

/** The market's rules at this moment, as the quote builder wants them. Shared by quotes and the website's market board. */
function modelOf(snap: MarketSnapshot, cls: MarketClass, rung: Rung) {
  const cfg = snap.cfg;
  const status = snap.mark.status as Status;
  const chainProfile = cfg.profiles[status]!;
  const lev = Number(chainProfile.maxLeverageE18) / 1e18;
  const profile: SessionProfileCfg = {
    opensAllowed: chainProfile.opensAllowed,
    leverage: { micro: lev, small: lev, smid: lev, index: lev },
    maxPositionBpsOfV: chainProfile.maxPositionBpsOfV,
    perWallet: chainProfile.perWallet,
    extraSpreadBps: chainProfile.extraSpreadBps,
    liquidation: LIQUIDATION_BY_STATUS[status] ?? 'none',
  };

  const V = snap.navUsdg;
  const caps = marketCaps(
    V,
    { ...RUNGS[rung], netSkewBps: cfg.netSkewBpsOfV, grossOiBps: cfg.grossOiBpsOfV, positionBps: cfg.positionBpsOfV },
    cfg.absOiCapUsdg,
  );
  const globalCap = (V * TOTAL_NET_BPS) / 10_000n;
  const market: QuoteMarket = {
    class: cls,
    state: cfg.state as MarketState,
    feeBps: cfg.feeBps,
    maxExecDeviationBps: cfg.maxExecDeviationBps,
    maxConfidenceBps: cfg.maxConfidenceBps,
    frozenSpreadBps: cfg.frozenSpreadBps,
    skewScaleE18: cfg.skewScaleE18,
    caps,
    oi: { longUsdg: snap.longOI, shortUsdg: snap.shortOI },
    globalNetRoomUsdg: globalCap > snap.totalAbsNet ? globalCap - snap.totalAbsNet : 0n,
    leverageCap: RUNGS[rung].leverage[cls],
    navUsdg: V,
    deleveraging: snap.deleveraging,
  };
  return { status, chainProfile, profile, caps, market };
}

/** What the website's market board and ticket need: the current limits, in plain numbers. */
export interface MarketLimits {
  /** 1 active, 2 close-only, 3 paused (the on-chain MarketState). */
  state: number;
  opensAllowed: boolean;
  /** The ceiling for a new open right now: the lower of the session profile and the Counter's rung. */
  maxLeverage: number;
  openSpreadBps: number;
  frozenSpreadBps: number;
  feeBps: number;
  borrowBaseBpsPerHour: number;
  maintenanceMarginBps: number;
  minHoldSec: number;
  /** Largest single position in USDG notional. */
  positionCapUsdg: bigint;
  longRoomUsdg: bigint;
  shortRoomUsdg: bigint;
  deleveraging: boolean;
  navUsdg: bigint;
  longOiUsdg: bigint;
  shortOiUsdg: bigint;
}

export function marketLimits(snap: MarketSnapshot, cls: MarketClass, rung: Rung): MarketLimits {
  const { chainProfile, profile, caps, market } = modelOf(snap, cls, rung);
  const cfg = snap.cfg;
  const room = capacity(market.oi, caps, market.globalNetRoomUsdg);
  const byProfile = (snap.navUsdg * BigInt(chainProfile.maxPositionBpsOfV)) / 10_000n;
  return {
    state: cfg.state,
    opensAllowed: chainProfile.opensAllowed,
    maxLeverage: Math.min(profile.leverage[cls], market.leverageCap),
    openSpreadBps: chainProfile.extraSpreadBps,
    frozenSpreadBps: cfg.frozenSpreadBps,
    feeBps: cfg.feeBps,
    borrowBaseBpsPerHour: cfg.borrowBaseBpsPerHour,
    maintenanceMarginBps: cfg.maintenanceMarginBps,
    minHoldSec: cfg.minHoldSec,
    positionCapUsdg: chainProfile.perWallet ? byProfile : caps.positionUsdg < byProfile ? caps.positionUsdg : byProfile,
    longRoomUsdg: room.longRoomUsdg,
    shortRoomUsdg: room.shortRoomUsdg,
    deleveraging: snap.deleveraging,
    navUsdg: snap.navUsdg,
    longOiUsdg: snap.longOI,
    shortOiUsdg: snap.shortOI,
  };
}

/** Maps live chain state onto the pure quote builder, then re-checks the rules the contract applies at the execution price. */
export function quoteFromChain(i: ChainQuoteInput): ChainQuote {
  const { snap, trader } = i;
  const cfg = snap.cfg;
  const { status, chainProfile, profile, market } = modelOf(snap, i.cls, i.rung);
  const mark: QuoteMark = {
    priceE18: snap.mark.priceE18,
    confidenceBps: snap.mark.confidenceBps,
    status,
    sequence: snap.mark.sequence,
    ageSec: Math.max(0, Math.floor(i.nowMs / 1000) - Number(snap.mark.updatedAt)),
    breaker: snap.mark.breaker,
  };
  const session = sessionAt(i.nowMs, i.calendar, { windowTz: i.windowTz, openGuardMinutes: 20 });
  // The contract runs its own guard from the moment the market entered Open on-chain. Quote inside either window, and
  // never below the contract's guard spread or above its guard ticket, so the quote cannot revert.
  const nowSec = BigInt(Math.floor(i.nowMs / 1000));
  const chainGuard = status === Status.Open && cfg.openGuardSec > 0 && nowSec < snap.openSince + BigInt(cfg.openGuardSec);
  const req: QuoteRequest = {
    sizeDeltaE18: i.sizeDeltaE18,
    marginUsdg: i.marginUsdg,
    existingMarginUsdg: BigInt(trader.position.margin),
    positionSizeE18: trader.position.size,
    openGuard: session.openGuard || chainGuard,
    minOpenSpreadBps: i.minOpenSpreadBps,
    openGuardSpreadBps: Math.max(OPEN_GUARD_EXTRA_SPREAD_BPS, cfg.openGuardSpreadBps),
    openGuardPositionBpsOfV: cfg.openGuardSec > 0 ? cfg.openGuardPositionBpsOfV : undefined,
    profile,
    walletNotionalUsdg: trader.walletNotionalUsdg,
    maxMarkAgeSec: cfg.maxMarkAgeSec,
  };

  const result = buildTradeQuote(market, mark, req);
  const maxLevOnChain = chainProfile.maxLeverageE18;
  const maxLeverageE18 = result.ok ? (result.maxLeverageE18 < maxLevOnChain ? result.maxLeverageE18 : maxLevOnChain) : 0n;

  // The contract measures leverage on equity at the execution price; the builder measured margin at the mark. Re-check
  // so a quote that would revert on-chain is refused here instead. Adding to a losing position counts its loss.
  if (result.ok && !result.reducing) {
    const newSize = trader.position.size + i.sizeDeltaE18;
    const sameSide = trader.position.size !== 0n && trader.position.size > 0n === i.sizeDeltaE18 > 0n;
    const totalMargin = (sameSide ? BigInt(trader.position.margin) : 0n) + i.marginUsdg;
    const oldSize = trader.position.size;
    const oldPnl = sameSide ? ((result.execPriceE18 - trader.position.entry) * oldSize) / E18 / 10n ** 12n : 0n;
    const equity = BigInt(totalMargin) + oldPnl;
    const abs = newSize < 0n ? -newSize : newSize;
    if (equity <= 0n || notionalUsdg(abs, result.execPriceE18) * E18 > equity * maxLeverageE18) {
      return { result: { ok: false, code: 'leverage_exceeded', message: 'add margin: leverage at the execution price is above the maximum' }, maxLeverageE18: 0n, execPriceE18: result.execPriceE18 };
    }
  }
  return { result, maxLeverageE18, execPriceE18: result.ok ? result.execPriceE18 : undefined };
}
