import {
  RUNGS,
  Status,
  buildTradeQuote,
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
}

export interface ChainQuote {
  result: QuoteResult;
  /** The leverage ceiling written into the signed quote (never above the on-chain profile). */
  maxLeverageE18: bigint;
}

const LIQUIDATION_BY_STATUS = ['none', 'two_source', 'two_source', 'margin_only', 'none', 'none'] as const;

/** Maps live chain state onto the pure quote builder, then re-checks the rules the contract applies at the execution price. */
export function quoteFromChain(i: ChainQuoteInput): ChainQuote {
  const { snap, trader, cfg } = { ...i, cfg: i.snap.cfg };
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
    { ...RUNGS[i.rung], netSkewBps: cfg.netSkewBpsOfV, grossOiBps: cfg.grossOiBpsOfV, positionBps: cfg.positionBpsOfV },
    cfg.absOiCapUsdg,
  );
  const globalCap = (V * TOTAL_NET_BPS) / 10_000n;
  const market: QuoteMarket = {
    class: i.cls,
    state: cfg.state as MarketState,
    feeBps: cfg.feeBps,
    maxExecDeviationBps: cfg.maxExecDeviationBps,
    maxConfidenceBps: cfg.maxConfidenceBps,
    frozenSpreadBps: cfg.frozenSpreadBps,
    skewScaleE18: cfg.skewScaleE18,
    caps,
    oi: { longUsdg: snap.longOI, shortUsdg: snap.shortOI },
    globalNetRoomUsdg: globalCap > snap.totalAbsNet ? globalCap - snap.totalAbsNet : 0n,
    leverageCap: RUNGS[i.rung].leverage[i.cls],
    navUsdg: V,
    deleveraging: snap.deleveraging,
  };
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
      return { result: { ok: false, code: 'leverage_exceeded', message: 'add margin: leverage at the execution price is above the maximum' }, maxLeverageE18: 0n };
    }
  }
  return { result, maxLeverageE18 };
}
