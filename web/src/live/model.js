import { big, e18Num, percentChange, usdgNum } from './units.js';
import { KIND_LABEL } from './orders.js';

// Pure translation from API responses to what the screens draw. No React, no network: easy to test, hard to get wrong.

const NAMES = {
  USAR: 'USA Rare Earth', CLSK: 'CleanSpark', RGTI: 'Rigetti Computing', WYFI: 'WhiteFiber', NNE: 'NANO Nuclear Energy', RCAT: 'Red Cat Holdings',
  TE: 'T1 Energy', POET: 'POET Technologies', FLNC: 'Fluence Energy', QUBT: 'Quantum Computing', DJT: 'Trump Media & Technology Group',
  RUN: 'Sunrun', SLS: 'SELLAS Life Sciences',
};
export const companyName = (symbol) => NAMES[symbol] ?? symbol;

export const STATUS_LABEL = { open: 'Open', extended: 'Extended hours', weekend: 'Weekend', frozen: 'Frozen', halted: 'Halted', unset: 'No price yet' };
const CHAIN_STATUS = ['unset', 'open', 'extended', 'weekend', 'frozen', 'halted'];
export const CLASS_LABEL = { micro: 'Micro', small: 'Small', smid: 'Smid', index: 'Index' };

const TRADABLE_STATES = new Set(['open', 'extended', 'weekend']);

/** What each market state means for a trader, in a sentence. */
export const STATUS_NOTE = {
  open: 'Open: both price sources agree and the normal limits apply.',
  extended: 'Extended hours: leverage and ticket size are reduced and the spread is wider.',
  weekend: 'Weekend: the price is held near the last regular close. Leverage, ticket size and spreads follow the weekend limits, and borrow still accrues.',
  frozen: 'Frozen: price sources are stale or a corporate action is pending. New positions are stopped; you can still close.',
  halted: 'Halted: the stock is halted. New positions are stopped; you can still close.',
  unset: 'No price has been published for this market yet.',
};

/** One market, ready to draw. `m` is an element of GET /v1/markets. */
export function marketView(m) {
  const t = m.trading ?? null;
  const feed = m.mark ?? null;
  const chainPrice = t ? e18Num(t.markE18) : 0;
  const feedPrice = feed?.priceE18 ? e18Num(feed.priceE18) : 0;
  const price = chainPrice || feedPrice;
  const refClose = feed?.refCloseE18 ? e18Num(feed.refCloseE18) : 0;
  const status = feed?.status ?? (t ? CHAIN_STATUS[t.markStatus] ?? 'unset' : 'unset');
  const blockers = [];
  if (!t) blockers.push('The exchange contracts are not reachable right now.');
  else {
    if (t.state === 2) blockers.push('This market is close-only. You can reduce or close a position.');
    if (t.state === 3) blockers.push('This market is paused.');
    if (!t.opensAllowed) blockers.push('New positions are not allowed in the current market state.');
    if (t.deleveraging) blockers.push('The Counter is deleveraging: new positions are stopped.');
    if (!chainPrice) blockers.push('This market has no price yet.');
  }
  if (!TRADABLE_STATES.has(status) && t) blockers.push(STATUS_NOTE[status] ?? 'New positions are stopped in the current market state.');
  // Listing-rule findings are information, not a stop: whether they block opens is decided by the price service and the contracts.
  const warnings = feed ? [...(feed.eligible === false ? feed.eligibilityReasons ?? [] : []), ...(feed.eligibilityWarnings ?? [])] : [];
  return {
    symbol: m.symbol,
    name: companyName(m.symbol),
    class: m.class,
    classLabel: CLASS_LABEL[m.class] ?? m.class,
    marketId: m.marketId,
    price,
    refClose,
    change: refClose ? percentChange(price, refClose) : null,
    status,
    statusLabel: STATUS_LABEL[status] ?? status,
    statusNote: STATUS_NOTE[status] ?? '',
    warnings,
    feedUp: m.markFeedUp !== false,
    confidenceBps: feed?.confidenceBps ?? (t ? t.markConfidenceBps : null),
    dispersionBps: feed?.dispersionBps ?? null,
    sources: feed?.sources ?? [],
    freezeReasons: feed?.freezeReasons ?? [],
    session: feed?.session ?? null,
    openGuard: Boolean(feed?.openGuard),
    markUpdatedAt: t ? Number(big(t.markUpdatedAt)) : null,
    limits: t && {
      maxLeverage: t.maxLeverage,
      openSpreadBps: t.openSpreadBps,
      frozenSpreadBps: t.frozenSpreadBps,
      feeBps: t.feeBps,
      borrowBaseBpsPerHour: t.borrowBaseBpsPerHour,
      maintenanceMarginBps: t.maintenanceMarginBps,
      positionCap: usdgNum(t.positionCapUsdg),
      longRoom: usdgNum(t.longRoomUsdg),
      shortRoom: usdgNum(t.shortRoomUsdg),
      longOi: usdgNum(t.longOiUsdg),
      shortOi: usdgNum(t.shortOiUsdg),
      nav: usdgNum(t.navUsdg),
      state: t.state,
    },
    canOpen: Boolean(t && t.state === 1 && t.opensAllowed && !t.deleveraging && chainPrice > 0 && TRADABLE_STATES.has(status)),
    blockers: [...new Set(blockers)],
  };
}

/** Health of one open position, from the figures the API computed on-chain state into. */
export function positionView(p) {
  const size = big(p.sizeE18);
  const side = size >= 0n ? 'long' : 'short';
  const mark = e18Num(p.markE18);
  const entry = e18Num(p.entryE18);
  const margin = usdgNum(p.marginUsdg);
  const equity = p.equityUsdg === undefined ? margin : usdgNum(p.equityUsdg);
  const maintenance = p.maintenanceUsdg === undefined ? 0 : usdgNum(p.maintenanceUsdg);
  const notional = p.notionalUsdg === undefined ? 0 : usdgNum(p.notionalUsdg);
  const pnl = p.pnlUsdg === undefined ? 0 : usdgNum(p.pnlUsdg);
  const liq = p.liquidationE18 === null || p.liquidationE18 === undefined ? null : e18Num(p.liquidationE18);
  const buffer = equity - maintenance;
  const healthPercent = equity > 0 ? Math.max(0, Math.min(100, (buffer / equity) * 100)) : 0;
  const distancePercent = liq === null || !mark ? null : ((side === 'long' ? mark - liq : liq - mark) / mark) * 100;
  return {
    symbol: p.symbol,
    marketId: p.marketId,
    side,
    sizeE18: size,
    quantity: Math.abs(e18Num(size)),
    entry,
    mark,
    margin,
    notional,
    pnl,
    pnlPercent: margin > 0 ? (pnl / margin) * 100 : 0,
    equity,
    maintenance,
    buffer,
    healthPercent,
    liquidation: liq,
    distancePercent,
    leverage: margin > 0 ? (Math.abs(e18Num(size)) * entry) / margin : 0,
    effectiveLeverage: equity > 0 ? notional / equity : Infinity,
    maintenanceBps: p.maintenanceMarginBps,
    status: buffer <= 0 ? 'Below maintenance' : distancePercent !== null && distancePercent < 10 ? 'Low buffer' : 'Within limits',
    openedAt: Number(big(p.openedAt)),
  };
}

/** A pending order from the API's order table. */
export function orderView(o) {
  const body = o.body ?? {};
  const sizeDelta = big(body.sizeDeltaE18 ?? 0);
  const protective = o.kind === 2 || o.kind === 3;
  return {
    nonce: big(o.nonce),
    nonceText: String(o.nonce),
    symbol: o.symbol,
    kind: o.kind,
    label: KIND_LABEL[o.kind] ?? 'Order',
    protective,
    // Entries have a signed size; a protective order has none, so its side is the opposite of how it closes.
    side: protective ? null : sizeDelta >= 0n ? 'long' : 'short',
    trigger: e18Num(o.triggerE18),
    triggerAbove: Boolean(o.triggerAbove),
    margin: usdgNum(body.marginUsdg ?? 0),
    quantity: protective ? null : Math.abs(e18Num(sizeDelta)),
    expiresAt: new Date(o.expiry).getTime(),
    status: o.status,
  };
}

const PATH_LABEL = ['Quote', 'Order', 'Close at mark', 'Liquidation'];
/** A past trade from the API's trade table. */
export function tradeView(t) {
  const delta = big(t.sizeDeltaE18);
  const price = e18Num(t.priceE18);
  return {
    id: `${t.txHash}:${t.logIndex}`,
    txHash: t.txHash,
    at: new Date(t.at).getTime(),
    symbol: t.symbol ?? '—',
    side: delta >= 0n ? 'buy' : 'sell',
    quantity: Math.abs(e18Num(delta)),
    notional: Math.abs(e18Num(delta)) * price,
    price,
    fee: usdgNum(t.feeUsdg),
    pnl: usdgNum(t.realizedPnlUsdg),
    path: PATH_LABEL[t.path] ?? 'Trade',
    liquidation: t.path === 3,
  };
}

/** Account figures for the strip at the top of the terminal. */
export function accountView(state, orders) {
  const positions = (state?.positions ?? []).map(positionView);
  const collateral = usdgNum(state?.collateralUsdg ?? 0);
  const wallet = usdgNum(state?.usdgBalance ?? 0);
  const margin = positions.reduce((s, p) => s + p.margin, 0);
  const pnl = positions.reduce((s, p) => s + p.pnl, 0);
  const exposure = positions.reduce((s, p) => s + p.notional, 0);
  const reserved = (orders ?? []).filter((o) => !o.protective).reduce((s, o) => s + o.margin, 0);
  return {
    positions,
    collateral,
    wallet,
    margin,
    pnl,
    exposure,
    reserved,
    equity: collateral + margin + pnl,
    /** What can fund a new trade: the deposited balance, plus the wallet (a permit moves it in the same transaction). */
    available: collateral + wallet,
    shares: big(state?.vaultShares ?? 0),
    sharesValue: usdgNum(state?.vaultSharesValueUsdg ?? 0),
  };
}

/** Live protective levels for a position, taken from the pending orders: { takeProfit, stopLoss } as order views or null. */
export function protectionFor(symbol, orders) {
  const mine = orders.filter((o) => o.symbol === symbol && o.protective);
  return { takeProfit: mine.find((o) => o.kind === 2) ?? null, stopLoss: mine.find((o) => o.kind === 3) ?? null };
}

/** Plain-English ticket estimate from a preview response, or the reason it was refused. */
export function previewView(p) {
  if (!p) return null;
  if (!p.ok) return { ok: false, code: p.code, message: p.message };
  return {
    ok: true,
    sizeDeltaE18: big(p.sizeDeltaE18),
    execPrice: e18Num(p.execPriceE18),
    fee: usdgNum(p.feeUsdg),
    notional: usdgNum(p.notionalUsdg),
    spreadBps: p.spreadBps,
    reducing: p.reducing,
    liquidation: p.liquidationE18 === null || p.liquidationE18 === undefined ? null : e18Num(p.liquidationE18),
    shortfall: usdgNum(p.shortfallUsdg),
    maxLeverage: Number(big(p.maxLeverageE18)) / 1e18,
  };
}

/** Short text for how long ago / from now a unix-ms time is. */
export function relativeTime(ms, now = Date.now()) {
  const s = Math.round((ms - now) / 1000);
  const abs = Math.abs(s);
  const unit = abs < 90 ? [abs, 's'] : abs < 5400 ? [Math.round(abs / 60), 'm'] : abs < 129_600 ? [Math.round(abs / 3600), 'h'] : [Math.round(abs / 86_400), 'd'];
  return s >= 0 ? `in ${unit[0]}${unit[1]}` : `${unit[0]}${unit[1]} ago`;
}
