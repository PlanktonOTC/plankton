import React, { useEffect, useMemo, useState } from 'react';
import { PresetControls, usePresets } from './Presets.jsx';
import { presetLevels } from '../live/presets.js';
import { TWAP_INTERVALS, TWAP_MAX_SLICES, TWAP_MIN_SLICES, intervalLabel, planTwap, twapStartDelaySec } from '../live/twap.js';
import { Arrow, Modal, TxProgress, useTerminal } from './shared.jsx';
import RiskPanel from './Risk.jsx';
import { friendlyError } from '../live/errors.js';
import { canGoGasless, ENTRY_SLIPPAGE_BPS, entryOrder, ladderProblem, ladderRungs, marketOrder, MAX_LADDER_STEPS, MIN_LADDER_STEPS, newNonce, protectionOrder, protectionProblem } from '../live/orders.js';
import { previewView } from '../live/model.js';
import { useDebounced, usePreview } from '../live/queries.js';
import { depositCollateral, gaslessOrder, openTrade, placeLadder, placeOrder } from '../live/trade.js';
import { money, parseE18, parseUsdg, priceDigits } from '../live/units.js';
import { useI18n } from '../i18n';

const DAY = 86_400n;
const EXPIRIES = [['1', '1 day'], ['7', '7 days'], ['30', '30 days']];
/** Orders are sized with a little leverage headroom: the fill price differs slightly from the trigger, and leverage is checked at the fill. */
const ORDER_LEVERAGE_HEADROOM = 0.98;

/** Liquidation estimate for an order that has not filled: the same maintenance maths the API uses, from the trigger price. */
export function estimateLiquidation(entry, leverage, side, maintenanceBps) {
  const mm = maintenanceBps / 10_000;
  return side === 'long' ? (entry * (1 - 1 / leverage)) / (1 - mm) : (entry * (1 + 1 / leverage)) / (1 + mm);
}

function LeverageControl({ value, onChange, max, locked, margin, reason }) {
  const { t: tr } = useI18n();
  const min = Math.min(1, max || 1);
  const span = Math.max(0.0001, max - min);
  const presets = [...new Set([2, 3, max].filter((n) => n >= min && n <= max))].sort((a, b) => a - b).slice(0, 3);
  return (
    <div className={`term-leverage-control ${locked ? 'is-limited' : ''}`} style={{ '--leverage-fill': `${((value - min) / span) * 100}%` }}>
      <div className="term-leverage-control-heading">
        <div><label htmlFor="term-leverage">{tr('Leverage')}</label><small>{tr('ISOLATED MARGIN')}</small></div>
        <output htmlFor="term-leverage" className="term-leverage-readout" aria-live="polite" key={value}>{value}<span>×</span></output>
      </div>
      <div className="term-leverage-input-wrap">
        <input id="term-leverage" aria-label={tr('Leverage')} aria-describedby="term-leverage-help" type="range" min={min} max={max || 1} step="0.5" value={value} disabled={locked || max <= min} onChange={(e) => onChange(Number(e.target.value))} />
        <div className="term-leverage-stops" aria-hidden="true"><i /><i /></div>
      </div>
      <div className="term-leverage-presets">
        {presets.map((n) => (
          <button type="button" key={n} className={value === n ? 'active' : ''} aria-pressed={value === n} disabled={locked} onClick={() => onChange(n)}>
            <span>{n}×</span><small>{money(100 / n, 1)}% {tr('margin')}</small>
          </button>
        ))}
      </div>
      <div className="term-leverage-exposure"><span>{tr('Position value')}</span><b key={`${value}-${margin}`}>{money((Number(margin) || 0) * value)} <small>USDG</small></b></div>
      <p id="term-leverage-help">{tr(reason || `Up to ${max}× in the current market state. Drag the handle, use arrow keys, or choose a level.`)}</p>
    </div>
  );
}

function ReviewActions({ primary, side, location }) {
  const { t: tr } = useI18n();
  return (
    <div className={`term-ticket-actions term-actions-${location}`}>
      {primary.error && <p className="term-form-error" role="status">{tr(primary.error)}</p>}
      <button type="submit" form="term-order-form" className={`term-primary ${side}`} disabled={primary.disabled} onClick={primary.onClick}>{tr(primary.label)} {primary.arrow !== false && <Arrow down={side === 'short'} />}</button>
      <p className="term-ticket-note">{tr(primary.note)}</p>
    </div>
  );
}

export default function Ticket({ market, account, orders }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const [side, setSide] = useState('long');
  const [type, setType] = useState('Market');
  const [margin, setMargin] = useState('100');
  const [leverage, setLeverage] = useState(2);
  const [trigger, setTrigger] = useState('');
  const [bracket, setBracket] = useState(false);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  // Which market and side the take-profit / stop-loss fields were last edited by hand for. Until then they follow the defaults.
  const [tpEditCtx, setTpEditCtx] = useState(null);
  const [slEditCtx, setSlEditCtx] = useState(null);
  const { presets, update: savePreset, reset: resetPresets } = usePresets();
  const [days, setDays] = useState('7');
  const [ladderFrom, setLadderFrom] = useState('');
  const [ladderTo, setLadderTo] = useState('');
  const [steps, setSteps] = useState(3);
  const [slices, setSlices] = useState(5);
  const [intervalSec, setIntervalSec] = useState(900);
  const [twapProgress, setTwapProgress] = useState(null);
  const [review, setReview] = useState(null);
  const [reviewError, setReviewError] = useState('');
  const limits = market.limits;
  const maxLev = limits?.maxLeverage ?? 1;
  const symbol = market.symbol;

  // A new market starts from its own price; leverage never sits above what the market allows right now.
  useEffect(() => setTrigger(market.price ? market.price.toFixed(priceDigits(market.price)) : ''), [symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!trigger && market.price) setTrigger(market.price.toFixed(priceDigits(market.price))); }, [market.price]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setLeverage((v) => Math.min(v, maxLev || 1)), [maxLev]);
  // Market orders start with protection on when the trader's defaults say so; limit and stop orders cannot carry it.
  useEffect(() => { setBracket(type === 'Market' && presets.auto); }, [type]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (t.sideRequest) setSide(t.sideRequest.side); }, [t.sideRequest]);

  const marginBig = parseUsdg(margin);
  const marginValid = marginBig !== null && marginBig > 0n;
  const existing = account.positions.find((p) => p.symbol === symbol);
  const oppositeOpen = existing && existing.side !== side;
  const triggerNum = Number(trigger);
  const feeRate = (limits?.feeBps ?? 8) / 10_000;
  const funds = account.available;

  const previewParams = useDebounced(
    type === 'Market' && marginValid && market.canOpen && !oppositeOpen
      ? { market: symbol, trader: t.wallet.address, side, marginUsdg: marginBig.toString(), leverage: String(leverage) }
      : null,
  );
  const previewQuery = usePreview(previewParams);
  const preview = type === 'Market' ? previewView(previewQuery.data) : null;

  // Take-profit and stop-loss fill in from the saved defaults, around the expected entry price, and stay put once the trader edits them.
  const presetRef = preview?.ok ? preview.execPrice : market.price;
  const presetCtx = `${symbol}|${side}`;
  const tpAuto = tpEditCtx !== presetCtx;
  const slAuto = slEditCtx !== presetCtx;
  const refReady = presetRef > 0;
  useEffect(() => {
    if (!bracket || !refReady) return;
    const lv = presetLevels(side, presetRef, presets, priceDigits(presetRef));
    if (tpAuto) setTp(lv.tp);
    if (slAuto) setSl(lv.sl);
  }, [bracket, presetCtx, presets.tpPct, presets.slPct, refReady, tpAuto, slAuto]); // eslint-disable-line react-hooks/exhaustive-deps
  function applyPresets() {
    const lv = presetLevels(side, presetRef, presets, priceDigits(presetRef));
    setTp(lv.tp); setSl(lv.sl); setTpEditCtx(null); setSlEditCtx(null);
  }
  const savePresetValues = (patch) => { savePreset(patch); setTpEditCtx(null); setSlEditCtx(null); };

  // A new ladder starts just inside the price and spreads 4% away from it, on the side it waits for.
  useEffect(() => {
    if (type !== 'Ladder' || !(market.price > 0)) return;
    const d = priceDigits(market.price);
    const dir = side === 'long' ? -1 : 1;
    setLadderFrom((market.price * (1 + dir * 0.01)).toFixed(d));
    setLadderTo((market.price * (1 + dir * 0.05)).toFixed(d));
  }, [type, side, symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  const ladderFromNum = Number(ladderFrom);
  const ladderToNum = Number(ladderTo);
  const ladderIssue = type === 'Ladder' && marginValid ? ladderProblem({ side, fromPrice: ladderFromNum, toPrice: ladderToNum, markPrice: market.price, steps, marginUsdg: marginBig }) : null;
  const rungs = useMemo(
    () => (type === 'Ladder' && marginValid && !ladderIssue ? ladderRungs({ fromPrice: ladderFromNum, toPrice: ladderToNum, steps, marginUsdg: marginBig, leverage, headroom: ORDER_LEVERAGE_HEADROOM, digits: priceDigits(market.price) }) : null),
    [type, marginValid, ladderIssue, ladderFromNum, ladderToNum, steps, marginBig, leverage, market.price],
  );

  // The numbers the ticket shows. A market order's come from the API (the same rules the signed quote uses); a limit or
  // stop order's are an estimate from its trigger price, because the fill price is not known until it fills.
  const orderEstimate = useMemo(() => {
    if (type === 'Ladder') {
      if (!rungs) return null;
      const notional = rungs.reduce((a, x) => a + Number(x.notionalUsdg) / 1e6, 0);
      const quantity = rungs.reduce((a, x) => a + Number(x.sizeE18) / 1e18, 0);
      const avg = notional / quantity;
      return { notional, price: avg, quantity, fee: notional * feeRate, liquidation: estimateLiquidation(avg, leverage * ORDER_LEVERAGE_HEADROOM, side, limits?.maintenanceMarginBps ?? 500) };
    }
    const refPrice = type === 'TWAP' ? market.price : triggerNum; // a TWAP slice buys at the market, so the current price stands in
    if (type === 'Market' || !marginValid || !(refPrice > 0)) return null;
    const notional = (Number(margin) || 0) * leverage * ORDER_LEVERAGE_HEADROOM;
    return { notional, price: refPrice, quantity: notional / refPrice, fee: notional * feeRate, liquidation: estimateLiquidation(refPrice, leverage * ORDER_LEVERAGE_HEADROOM, side, limits?.maintenanceMarginBps ?? 500) };
  }, [type, marginValid, margin, triggerNum, leverage, side, feeRate, limits, rungs, market.price]);

  // The TWAP schedule as it stands now (the real one is planned at confirm, from the chain's clock).
  const twapPlan = useMemo(
    () => (type !== 'TWAP' ? null : planTwap({ side, totalMarginUsdg: marginBig ?? 0n, leverage, slices, intervalSec, priceE18: market.price > 0 ? parseE18(market.price.toFixed(6)) : 0n, chainNow: BigInt(Math.floor(Date.now() / 1000)), feeBps: limits?.feeBps ?? 8, startDelaySec: twapStartDelaySec(slices) })),
    [type, side, marginBig, leverage, slices, intervalSec, market.price, limits],
  );
  const shown = type === 'Market' ? (preview?.ok ? { notional: preview.notional, price: preview.execPrice, fee: preview.fee, liquidation: preview.liquidation } : null) : orderEstimate;

  // Why the form cannot be submitted right now, most important first.
  const problems = [];
  if (!market.canOpen) problems.push(market.blockers[0] ?? 'New positions are not available in this market right now.');
  else if (oppositeOpen) problems.push(`Close or trim your ${existing.side} position before opening a ${side}.`);
  else if (!marginValid) problems.push('Enter a margin above 0 USDG.');
  else if (t.wallet.isConnected && marginValid && Number(margin) * (1 + leverage * feeRate) > funds + 0.005) problems.push(`Not enough USDG: you have ${money(funds)} between your wallet and the exchange.`);
  else if (type === 'Ladder' && ladderIssue) problems.push(ladderIssue);
  else if ((type === 'Limit' || type === 'Stop') && !(triggerNum > 0)) problems.push('Enter a trigger price above 0.');
  else if (type === 'Limit' && (side === 'long' ? triggerNum >= market.price : triggerNum <= market.price)) problems.push(`A ${side === 'long' ? 'buy' : 'sell'} limit must be ${side === 'long' ? 'below' : 'above'} the current price. Use Market to trade now.`);
  else if (type === 'Stop' && (side === 'long' ? triggerNum <= market.price : triggerNum >= market.price)) problems.push(`A ${side === 'long' ? 'buy' : 'sell'} stop must be ${side === 'long' ? 'above' : 'below'} the current price.`);
  else if (type === 'TWAP' && twapPlan && !twapPlan.ok) problems.push(twapPlan.problem);
  else if (type === 'Market' && previewParams && preview && !preview.ok) problems.push(friendlyError({ name: 'ApiError', status: 422, message: preview.code, body: { code: preview.code, message: preview.message } }));
  else if (bracket) {
    const ref = type === 'Market' ? (preview?.ok ? preview.execPrice : market.price) : triggerNum;
    const issue = protectionProblem(side, ref, tp, sl);
    if (!tp && !sl) problems.push('Set a take-profit, a stop-loss, or turn the option off.');
    else if (issue) problems.push(issue);
  }
  const waitingForPreview = type === 'Market' && marginValid && market.canOpen && !oppositeOpen && (!preview || previewQuery.isFetching);
  const primaryError = problems[0];

  function setMax() {
    const room = limits ? Math.max(0, limits.positionCap - (existing?.notional ?? 0)) / leverage : Infinity;
    const byFunds = funds / (1 + leverage * feeRate);
    const max = Math.floor(Math.min(room, byFunds) * 100) / 100;
    setMargin(max > 0 ? String(max) : '0');
  }

  function openReview(event) {
    event.preventDefault();
    if (!t.wallet.isConnected) return t.openWallet();
    if (t.wallet.wrongNetwork) return t.wallet.switchNetwork().catch((e) => t.notify(friendlyError(e)));
    if (primaryError) return t.notify(primaryError);
    if (type === 'Market' && !preview?.ok) return t.notify('Waiting for the price estimate. Try again in a moment.');
    setReviewError('');
    const gasless = type === 'Market' && canGoGasless(account.collateral, Number(margin), preview.fee);
    setReview({ side, type, margin, leverage, trigger, tp: bracket ? tp : '', sl: bracket ? sl : '', days, preview, estimate: orderEstimate, gasless, rungs, twap: type === 'TWAP' ? { slices, intervalSec } : null });
  }

  async function confirm() {
    const r = review;
    const marginUsdg = parseUsdg(r.margin);
    const address = t.wallet.address;
    let twapPlaced = 0;
    const result = await t.trader.run(async (ctx) => {
      const chainNow = BigInt((await ctx.api.get('/v1/config')).chainTimeSec);
      const protect = async (kind, price) => placeOrder(ctx, protectionOrder({ kind, positionSide: r.side, marketId: market.marketId, trader: address, triggerE18: parseE18(price), validAfter: chainNow, expiry: chainNow + 30n * DAY, nonce: newNonce() }));
      if (r.type === 'Market') {
        const hash = r.gasless
          ? await gaslessOrder(ctx, marketOrder({ marketId: market.marketId, trader: address, sizeDeltaE18: r.preview.sizeDeltaE18, marginUsdg, validAfter: chainNow, nonce: newNonce() }))
          : await openTrade(ctx, { symbol, sizeDeltaE18: r.preview.sizeDeltaE18, marginUsdg });
        // The position exists now: protective orders belong to it.
        if (r.tp) await protect('takeProfit', r.tp);
        if (r.sl) await protect('stopLoss', r.sl);
        return hash;
      }
      if (r.type === 'Ladder') {
        // One limit order per rung, all funded from deposited collateral: deposit any shortfall once, then sign each.
        const feeOf = (n) => (n * BigInt(limits?.feeBps ?? 8)) / 10_000n;
        const needed = r.rungs.reduce((a, x) => a + x.marginUsdg + feeOf(x.notionalUsdg), 0n) + 10_000n;
        const have = BigInt(Math.floor(account.collateral * 1e6));
        if (have < needed) await depositCollateral(ctx, needed - have);
        const expiry = chainNow + BigInt(r.days) * DAY;
        return placeLadder(ctx, r.rungs.map((x) => entryOrder({ type: 'limit', side: r.side, marketId: market.marketId, trader: address, sizeE18: x.sizeE18, triggerE18: x.triggerE18, marginUsdg: x.marginUsdg, validAfter: chainNow, expiry, nonce: newNonce(), maxSlippageBps: ENTRY_SLIPPAGE_BPS })));
      }
      if (r.type === 'TWAP') {
        // One signed market order per slice, each valid from its own time. The keeper fills each when its time comes.
        const plan = planTwap({ side: r.side, totalMarginUsdg: marginUsdg, leverage: r.leverage, slices: r.twap.slices, intervalSec: r.twap.intervalSec, priceE18: parseE18(market.price.toFixed(6)), chainNow, feeBps: limits?.feeBps ?? 8, startDelaySec: twapStartDelaySec(r.twap.slices) });
        if (!plan.ok) throw new Error(plan.problem);
        const haveNow = BigInt(Math.floor(account.collateral * 1e6));
        if (haveNow < plan.totals.collateralNeededUsdg) await depositCollateral(ctx, plan.totals.collateralNeededUsdg - haveNow);
        for (const s of plan.slices) {
          setTwapProgress({ done: s.index - 1, total: plan.slices.length });
          await placeOrder(ctx, marketOrder({ marketId: market.marketId, trader: address, sizeDeltaE18: s.sizeE18, marginUsdg: s.marginUsdg, validAfter: s.validAfter, nonce: newNonce(), lifetimeSec: s.expiry - s.validAfter }));
          twapPlaced = s.index;
        }
        return null;
      }
      }
      // Limit and stop: a signed instruction a keeper carries out later, funded from deposited collateral.
      const trig = parseE18(r.trigger);
      const notionalUsdg = (marginUsdg * BigInt(Math.round(r.leverage * ORDER_LEVERAGE_HEADROOM * 1000))) / 1000n;
      const sizeE18 = (notionalUsdg * 10n ** 30n) / trig; // USDG (6 dp) * 1e30 / price(E18) = size in E18
      const needed = marginUsdg + (notionalUsdg * BigInt(limits?.feeBps ?? 8)) / 10_000n + 10_000n;
      const have = BigInt(Math.floor(account.collateral * 1e6));
      if (have < needed) await depositCollateral(ctx, needed - have);
      const now = chainNow;
      await placeOrder(ctx, entryOrder({ type: r.type.toLowerCase(), side: r.side, marketId: market.marketId, trader: address, sizeE18, triggerE18: trig, marginUsdg, validAfter: now, expiry: now + BigInt(r.days) * DAY, nonce: newNonce(), maxSlippageBps: ENTRY_SLIPPAGE_BPS }));
      return null;
    });
    setTwapProgress(null);
    if (result.ok) {
      setReview(null);
      t.setBottomTab(r.type === 'Market' ? 'Positions' : 'Open orders');
      t.notify(r.type === 'TWAP' ? `${symbol} ${r.side} schedule set: ${r.twap.slices} slices, one every ${intervalLabel(r.twap.intervalSec)}. The first opens in about ${twapStartDelaySec(r.twap.slices)} seconds.` : r.type === 'Market' ? `${symbol} ${r.side} opened.${r.tp || r.sl ? ' Protection is set.' : ''}` : r.type === 'Ladder' ? `Ladder placed: ${r.rungs.length} ${symbol} limit orders from ${money(r.rungs[0].price, priceDigits(r.rungs[0].price))} to ${money(r.rungs[r.rungs.length - 1].price, priceDigits(r.rungs[0].price))}.` : `${r.type} order placed. A keeper executes it when ${symbol} reaches ${money(Number(r.trigger), priceDigits(Number(r.trigger)))}.`);
    } else setReviewError(`${result.message}${r.type === 'TWAP' && twapPlaced > 0 ? ` ${twapPlaced} of ${r.twap.slices} slices were already scheduled; cancel them in Open orders if you do not want them.` : ''}`);
  }

  const wrongNet = t.wallet.isConnected && t.wallet.wrongNetwork;
  const primary = {
    label: !t.wallet.isConnected ? 'Connect wallet' : wrongNet ? 'Switch network' : type === 'TWAP' ? `Review ${side} schedule` : `Review ${side}`,
    arrow: t.wallet.isConnected && !wrongNet,
    disabled: t.wallet.isConnected && !wrongNet && (Boolean(primaryError) || waitingForPreview),
    error: t.wallet.isConnected && !wrongNet && (marginValid || margin !== '') ? primaryError : null,
    note: t.wallet.isConnected ? 'You approve every transaction in your wallet. Review the estimate before confirming.' : 'Connect a wallet to trade. Nothing is sent until you confirm in your wallet.',
  };
  const previewFee = shown?.fee ?? 0;

  return (
    <aside className="term-ticket">
      <div className="term-ticket-body">
        <div className="term-panel-heading"><h2>{tr('Place an order')}</h2><span>{tr('ISOLATED')}</span></div>
        <form id="term-order-form" onSubmit={openReview}>
          <div className="term-side-switch">
            <button type="button" aria-pressed={side === 'long'} className={side === 'long' ? 'active long' : ''} onClick={() => setSide('long')}>{tr('Buy / Long')} <Arrow /></button>
            <button type="button" aria-pressed={side === 'short'} className={side === 'short' ? 'active short' : ''} onClick={() => setSide('short')}>{tr('Sell / Short')} <Arrow down /></button>
          </div>
          <div className="term-order-types">
            {['Market', 'Limit', 'Stop', 'Ladder', 'TWAP'].map((item) => (
              <button type="button" key={item} className={type === item ? 'active' : ''} aria-pressed={type === item} onClick={() => setType(item)}>{tr(item, null, 'order type')}</button>
            ))}
          </div>
          <div className="term-available"><span>{tr('Available')}</span><strong>{t.wallet.isConnected ? `${money(funds)} USDG` : '—'}</strong></div>
          {type === 'Ladder' && (
            <div className="term-ladder">
              <div className="term-ladder-prices">
                <label className="term-field">{tr('First step')}
                  <div><input aria-label="Ladder first price" type="number" min="0" step="any" value={ladderFrom} onChange={(e) => setLadderFrom(e.target.value)} /><span>USDG</span></div>
                </label>
                <label className="term-field">{tr('Last step')}
                  <div><input aria-label="Ladder last price" type="number" min="0" step="any" value={ladderTo} onChange={(e) => setLadderTo(e.target.value)} /><span>USDG</span></div>
                </label>
              </div>
              <div className="term-ladder-steps" role="group" aria-label="Ladder steps">
                <span>{tr('Steps')}</span>
                {Array.from({ length: MAX_LADDER_STEPS - MIN_LADDER_STEPS + 1 }, (_, i) => i + MIN_LADDER_STEPS).map((n) => (
                  <button type="button" key={n} className={steps === n ? 'active' : ''} aria-pressed={steps === n} onClick={() => setSteps(n)}>{n}</button>
                ))}
              </div>
              {rungs && (
                <ol className="term-ladder-rungs">
                  {rungs.map((x, i) => (
                    <li key={i}><span>{i + 1}</span><b>{money(x.price, priceDigits(x.price))}</b><i style={{ width: `${100 / rungs.length}%` }} /><small>{money(Number(x.marginUsdg) / 1e6)} USDG</small></li>
                  ))}
                </ol>
              )}
              <p className="term-ladder-note">{tr('{steps} limit orders, margin split evenly. One free signature each; a keeper fills every step the price reaches.', { steps })}</p>
            </div>
          )}
          {(type === 'Limit' || type === 'Stop') && (
            <label className="term-field">{tr('{type} price', { type: tr(type, null, 'order type') })}
              <div><input aria-label={tr('{type} order price', { type: tr(type, null, 'order type') })} type="number" min="0" step="any" value={trigger} onChange={(e) => setTrigger(e.target.value)} /><span>USDG</span></div>
            </label>
          )}
          <label className="term-field">{tr('Margin')}
            <div><input aria-label={tr('Trade margin in USDG')} type="number" min="0" step="0.01" value={margin} onChange={(e) => setMargin(e.target.value)} placeholder="0.00" /><span>USDG</span></div>
          </label>
          <div className="term-quick-values">
            {[50, 100, 200].map((amount) => <button type="button" key={amount} onClick={() => setMargin(String(amount))}>{amount}</button>)}
            <button type="button" onClick={setMax} disabled={!t.wallet.isConnected}>{tr('Max')}</button>
          </div>
          <LeverageControl value={leverage} onChange={setLeverage} max={maxLev} locked={!market.canOpen || maxLev <= 0} margin={margin} reason={!market.canOpen ? market.blockers[0] : limits && limits.maxLeverage < 3 ? `${market.statusLabel}: leverage is capped at ${limits.maxLeverage}×.` : undefined} />
          {(type === 'Limit' || type === 'Stop') && (
            <label className="term-field">{tr('Order stays active for')}
              <div><select aria-label={tr('Order expiry')} value={days} onChange={(e) => setDays(e.target.value)}>{EXPIRIES.map(([v, l]) => <option key={v} value={v}>{tr(l)}</option>)}</select></div>
            </label>
          )}
          {type === 'TWAP' && (
            <div className="term-twap">
              <div className="term-twap-fields">
                <label>{tr('Slices')}<select aria-label={tr('Number of slices')} value={slices} onChange={(e) => setSlices(Number(e.target.value))}>{Array.from({ length: TWAP_MAX_SLICES - TWAP_MIN_SLICES + 1 }, (_, i) => TWAP_MIN_SLICES + i).map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
                <label>{tr('One every')}<select aria-label={tr('Time between slices')} value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))}>{TWAP_INTERVALS.map(([v, l]) => <option key={v} value={v}>{tr(l)}</option>)}</select></label>
              </div>
              <p className="term-fineprint">{tr(twapPlan?.ok ? `Your ${money(Number(margin))} USDG margin is split into ${slices} market orders of about ${money(Number(margin) / slices)} USDG each. The first opens in about ${twapStartDelaySec(slices)} seconds, then one every ${intervalLabel(intervalSec)}.` : `Buy ${side === 'long' ? 'in' : 'out of'} slices over time instead of all at once.`)}</p>
            </div>
          )}
          <label className={`term-checkbox ${type !== 'Market' ? 'is-disabled' : ''}`}>
            <input type="checkbox" checked={bracket} disabled={type !== 'Market'} onChange={(e) => setBracket(e.target.checked)} />{tr('Take profit / Stop loss')} <span>{tr(type === 'Market' ? 'Optional' : type === 'TWAP' ? 'Set once it has filled' : 'Set after it fills')}</span>
          </label>
          {bracket && (
            <div className="term-bracket-fields">
              <label>{tr('Take profit')}<input aria-label={tr('Take profit price')} type="number" step="any" min="0" value={tp} onChange={(e) => { setTp(e.target.value); setTpEditCtx(presetCtx); }} placeholder="USDG" /></label>
              <label>{tr('Stop loss')}<input aria-label={tr('Stop loss price')} type="number" step="any" min="0" value={sl} onChange={(e) => { setSl(e.target.value); setSlEditCtx(presetCtx); }} placeholder="USDG" /></label>
            </div>
          )}
          {bracket && <PresetControls presets={presets} update={savePresetValues} reset={() => { resetPresets(); setTpEditCtx(null); setSlEditCtx(null); }} leverage={leverage} onApply={applyPresets} />}
          <div className="term-order-details">
            <div><span>{tr('Order value')}</span><strong>{shown ? money(shown.notional) : '0.00'} USDG</strong></div>
            <div><span>{tr(type === 'Market' ? 'Est. entry' : type === 'TWAP' ? 'Est. entry (now)' : 'Entry at trigger')}</span><strong>{shown ? money(shown.price, priceDigits(shown.price)) : '—'}</strong></div>
            <div><span>{tr('Trade fee · {pct}%', { pct: money((limits?.feeBps ?? 8) / 100, 2) })}</span><strong>{shown ? money(previewFee) : '0.00'} USDG</strong></div>
            <div><span>{tr('Est. liquidation')}</span><strong>{shown?.liquidation ? money(shown.liquidation, priceDigits(shown.liquidation)) : '—'}</strong></div>
            <div><span>{tr('Borrow / hour')}</span><strong>{limits ? `${money((limits.borrowBaseBpsPerHour ?? 0) / 100, 3)}%` : '—'} <small>{tr('base rate')}</small></strong></div>
          </div>
          <ReviewActions primary={primary} side={side} location="mobile" />
        </form>
        <div className="term-capacity">
          <h3>{tr('Counter capacity')} <button type="button" aria-label={tr('Explain Counter capacity')} onClick={() => t.setDialog({ type: 'capacity' })}>ⓘ</button></h3>
          <div><span>{tr('Long room')}</span><b>{limits ? money(limits.longRoom, 0) : '—'} USDG</b></div>
          <div className="term-capacity-track"><i style={{ width: `${limits ? Math.min(100, (limits.longRoom / Math.max(1, limits.positionCap * 5)) * 100) : 0}%` }} /></div>
          <div><span>{tr('Short room')}</span><b>{limits ? money(limits.shortRoom, 0) : '—'} USDG</b></div>
          <div className="term-capacity-track short"><i style={{ width: `${limits ? Math.min(100, (limits.shortRoom / Math.max(1, limits.positionCap * 5)) * 100) : 0}%` }} /></div>
          <p>{tr('Pool-versus-trader execution.')}<br />{tr('Capacity is not an order book.')}</p>
        </div>
        <RiskPanel position={existing} market={market} />
      </div>
      <ReviewActions primary={primary} side={side} location="desktop" />
      {review && (
        <ReviewDialog
          review={review}
          market={market}
          account={account}
          error={reviewError}
          busy={t.trader.busy}
          twapProgress={twapProgress}
          step={t.trader.step}
          hash={t.trader.hash}
          onClose={() => setReview(null)}
          onConfirm={confirm}
          limits={limits}
        />
      )}
    </aside>
  );
}

function ReviewDialog({ review: r, market, account, error, busy, step, hash, onClose, onConfirm, limits, twapProgress }) {
  const { t: tr } = useI18n();
  const isMarket = r.type === 'Market';
  const isTwap = r.type === 'TWAP';
  const twap = isTwap
    ? planTwap({ side: r.side, totalMarginUsdg: parseUsdg(r.margin) ?? 0n, leverage: r.leverage, slices: r.twap.slices, intervalSec: r.twap.intervalSec, priceE18: parseE18(market.price.toFixed(6)), chainNow: BigInt(Math.floor(Date.now() / 1000)), feeBps: limits?.feeBps ?? 8, startDelaySec: twapStartDelaySec(r.twap.slices) })
    : null;
  const p = r.preview;
  const marginNum = Number(r.margin);
  const shortfall = isMarket ? p?.shortfall ?? 0 : Math.max(0, marginNum * (1 + r.leverage * ((limits?.feeBps ?? 8) / 10_000)) - account.collateral);
  const isLadder = r.type === 'Ladder';
  const spanText = (sec) => (sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 86_400 ? `${Math.round(sec / 360) / 10} h` : `${Math.round(sec / 8640) / 10} days`);
  const rows = isLadder
    ? [['Total margin', `${money(marginNum)} USDG`], ['Leverage', `${r.leverage}× per step (sized to ${ORDER_LEVERAGE_HEADROOM * 100}% for fill headroom)`], ...r.rungs.map((x, i) => [`Step ${i + 1}`, `${money(x.price, priceDigits(x.price))} · ${money(Number(x.marginUsdg) / 1e6)} USDG`]), ['Active for', `${r.days} day${r.days === '1' ? '' : 's'}`]]
    : isTwap && twap?.ok
    ? [['Total margin', `${money(marginNum)} USDG`], ['Slices', `${r.twap.slices} market orders of about ${money(marginNum / r.twap.slices)} USDG margin`], ['One every', intervalLabel(r.twap.intervalSec)], ['First slice opens', `in about ${twapStartDelaySec(r.twap.slices)} seconds`], ['Last slice opens', `in about ${spanText(twapStartDelaySec(r.twap.slices) + Number(twap.totals.spanSec))}`], ['Leverage', `${r.leverage}x (sized to ${ORDER_LEVERAGE_HEADROOM * 100}% for fill headroom)`], ['Est. total notional', `${money(Number(twap.totals.notionalUsdg) / 1e6)} USDG`], ['Est. total fees', `${money(Number(twap.totals.feeUsdg) / 1e6)} USDG`]]
    : isMarket && p?.ok
    ? [['Margin', `${money(marginNum)} USDG`], ['Notional', `${money(p.notional)} USDG`], ['Estimated entry', money(p.execPrice, priceDigits(p.execPrice))], ['Trade fee', `${money(p.fee)} USDG`], ['Spread', `${p.spreadBps} bps`], ['Estimated liquidation', p.liquidation ? money(p.liquidation, priceDigits(p.liquidation)) : '—']]
    : [['Margin reserved', `${money(marginNum)} USDG`], ['Leverage', `${r.leverage}× (sized to ${ORDER_LEVERAGE_HEADROOM * 100}% for fill headroom)`], ['Trigger price', money(Number(r.trigger), priceDigits(Number(r.trigger)))], ['Active for', `${r.days} day${r.days === '1' ? '' : 's'}`]];
  return (
    <Modal title={tr(isMarket ? 'Review order' : isTwap ? 'Review TWAP schedule' : `Review ${r.type.toLowerCase()} order`)} onClose={onClose} busy={busy}>
      <div className="term-modal-market">
        <span className="term-symbol-square">{market.symbol[0]}</span>
        <div><h3>{market.symbol} / USDG</h3><p>{tr(r.side.toUpperCase())} · {tr(r.type, null, 'order type')} · {r.leverage}× {tr('isolated')}</p></div>
      </div>
      {rows.map(([label, value]) => <div className="term-detail" key={label}><span>{tr(label)}</span><b>{tr(value)}</b></div>)}
      {r.tp && <div className="term-detail"><span>{tr('Take profit')}</span><b>{r.tp}</b></div>}
      {r.sl && <div className="term-detail"><span>{tr('Stop loss')}</span><b>{r.sl}</b></div>}
      {isMarket && r.gasless && <p className="term-modal-intro">{tr('Gasless: you sign one message and pay no gas. A keeper fills the order from your deposited USDG within a few seconds.')}</p>}
      {isMarket && !r.gasless && <p className="term-modal-intro">{tr('Tip: deposit USDG in Account & deposits once, and market orders become a single gas-free signature.')}</p>}
      {isTwap && <p className="term-modal-intro">{tr("You sign {n} orders now, with no gas. A keeper fills each one when its time comes and pays the gas, even if you close this page. Each slice is sized at today's price, and fills at the price quoted when it opens, within its slippage limit.", { n: r.twap.slices })}</p>}
      {shortfall > 0.005 && !r.gasless && (
        <p className="term-modal-warning">{tr(isMarket ? `Your wallet will move about ${money(shortfall)} USDG into the exchange as part of this order (one permit signature, no separate approval).` : `This order is funded from your deposited USDG, and you have ${money(account.collateral)}. About ${money(shortfall)} USDG will be deposited from your wallet first.`)}</p>
      )}
      <p className="term-modal-warning">
        {tr(isMarket
          ? 'A fresh signed quote is fetched when you confirm and is valid for up to 60 seconds. Liquidation is an estimate; borrow charges accrue while the position is open.'
          : isLadder
          ? tr(`No transaction is sent now: you sign ${r.rungs.length} orders, one per step, with no gas. A keeper fills each step when ${market.symbol} reaches it, and any step can be cancelled before then.`)
          : isTwap
          ? tr('If the market is closed or frozen when a slice opens, that slice is skipped and its margin stays in your balance. Slices that fill add to one position. Cancel any slice that has not filled yet in Open orders.')
          : tr('No transaction is sent now: you sign an order that a keeper carries out when the trigger is reached. It can be cancelled any time before then. A gap in the price can fill beyond the trigger, within the order\'s slippage limit.'))}
        {r.tp || r.sl ? ` ${tr('Take-profit and stop-loss each need one more signature after the position opens.')}` : ''}
      </p>
      <TxProgress step={step} hash={hash} />
      {twapProgress && <p className="term-modal-intro" role="status">{tr('Signing slice {n} of {total}. Approve each request in your wallet.', { n: twapProgress.done + 1, total: twapProgress.total })}</p>}
      {error && <p className="term-form-error" role="alert">{tr(error)}</p>}
      <button className="term-primary" disabled={busy || (isTwap && !twap?.ok)} onClick={onConfirm}>{tr(busy ? 'Working…' : isMarket ? `${r.gasless ? 'Sign' : 'Confirm'} ${r.side}${r.gasless ? ' · no gas' : ''}` : isLadder ? `Sign ${r.rungs.length} orders · no gas` : isTwap ? `Sign ${r.twap.slices} orders · no gas` : 'Sign and place order')} <Arrow down={r.side === 'short'} /></button>
    </Modal>
  );
}
