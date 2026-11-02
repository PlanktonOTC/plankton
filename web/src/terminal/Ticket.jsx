import React, { useEffect, useMemo, useState } from 'react';
import { Arrow, Modal, TxProgress, useTerminal } from './shared.jsx';
import RiskPanel from './Risk.jsx';
import { friendlyError } from '../live/errors.js';
import { ENTRY_SLIPPAGE_BPS, entryOrder, newNonce, protectionOrder, protectionProblem } from '../live/orders.js';
import { previewView } from '../live/model.js';
import { useDebounced, usePreview } from '../live/queries.js';
import { depositCollateral, openTrade, placeOrder } from '../live/trade.js';
import { money, parseE18, parseUsdg, priceDigits } from '../live/units.js';

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
  const min = Math.min(1, max || 1);
  const span = Math.max(0.0001, max - min);
  const presets = [...new Set([2, 3, max].filter((n) => n >= min && n <= max))].sort((a, b) => a - b).slice(0, 3);
  return (
    <div className={`term-leverage-control ${locked ? 'is-limited' : ''}`} style={{ '--leverage-fill': `${((value - min) / span) * 100}%` }}>
      <div className="term-leverage-control-heading">
        <div><label htmlFor="term-leverage">Leverage</label><small>ISOLATED MARGIN</small></div>
        <output htmlFor="term-leverage" className="term-leverage-readout" aria-live="polite" key={value}>{value}<span>×</span></output>
      </div>
      <div className="term-leverage-input-wrap">
        <input id="term-leverage" aria-label="Leverage" aria-describedby="term-leverage-help" type="range" min={min} max={max || 1} step="0.5" value={value} disabled={locked || max <= min} onChange={(e) => onChange(Number(e.target.value))} />
        <div className="term-leverage-stops" aria-hidden="true"><i /><i /></div>
      </div>
      <div className="term-leverage-presets">
        {presets.map((n) => (
          <button type="button" key={n} className={value === n ? 'active' : ''} aria-pressed={value === n} disabled={locked} onClick={() => onChange(n)}>
            <span>{n}×</span><small>{money(100 / n, 1)}% margin</small>
          </button>
        ))}
      </div>
      <div className="term-leverage-exposure"><span>Position value</span><b key={`${value}-${margin}`}>{money((Number(margin) || 0) * value)} <small>USDG</small></b></div>
      <p id="term-leverage-help">{reason || `Up to ${max}× in the current market state. Drag the handle, use arrow keys, or choose a level.`}</p>
    </div>
  );
}

function ReviewActions({ primary, side, location }) {
  return (
    <div className={`term-ticket-actions term-actions-${location}`}>
      {primary.error && <p className="term-form-error" role="status">{primary.error}</p>}
      <button type="submit" form="term-order-form" className={`term-primary ${side}`} disabled={primary.disabled} onClick={primary.onClick}>{primary.label} {primary.arrow !== false && <Arrow down={side === 'short'} />}</button>
      <p className="term-ticket-note">{primary.note}</p>
    </div>
  );
}

export default function Ticket({ market, account, orders }) {
  const t = useTerminal();
  const [side, setSide] = useState('long');
  const [type, setType] = useState('Market');
  const [margin, setMargin] = useState('100');
  const [leverage, setLeverage] = useState(2);
  const [trigger, setTrigger] = useState('');
  const [bracket, setBracket] = useState(false);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [days, setDays] = useState('7');
  const [review, setReview] = useState(null);
  const [reviewError, setReviewError] = useState('');
  const limits = market.limits;
  const maxLev = limits?.maxLeverage ?? 1;
  const symbol = market.symbol;

  // A new market starts from its own price; leverage never sits above what the market allows right now.
  useEffect(() => setTrigger(market.price ? market.price.toFixed(priceDigits(market.price)) : ''), [symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!trigger && market.price) setTrigger(market.price.toFixed(priceDigits(market.price))); }, [market.price]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setLeverage((v) => Math.min(v, maxLev || 1)), [maxLev]);
  useEffect(() => { if (type !== 'Market') setBracket(false); }, [type]);
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

  // The numbers the ticket shows. A market order's come from the API (the same rules the signed quote uses); a limit or
  // stop order's are an estimate from its trigger price, because the fill price is not known until it fills.
  const orderEstimate = useMemo(() => {
    if (type === 'Market' || !marginValid || !(triggerNum > 0)) return null;
    const notional = (Number(margin) || 0) * leverage * ORDER_LEVERAGE_HEADROOM;
    return { notional, price: triggerNum, quantity: notional / triggerNum, fee: notional * feeRate, liquidation: estimateLiquidation(triggerNum, leverage * ORDER_LEVERAGE_HEADROOM, side, limits?.maintenanceMarginBps ?? 500) };
  }, [type, marginValid, margin, triggerNum, leverage, side, feeRate, limits]);
  const shown = type === 'Market' ? (preview?.ok ? { notional: preview.notional, price: preview.execPrice, fee: preview.fee, liquidation: preview.liquidation } : null) : orderEstimate;

  // Why the form cannot be submitted right now, most important first.
  const problems = [];
  if (!market.canOpen) problems.push(market.blockers[0] ?? 'New positions are not available in this market right now.');
  else if (oppositeOpen) problems.push(`Close or trim your ${existing.side} position before opening a ${side}.`);
  else if (!marginValid) problems.push('Enter a margin above 0 USDG.');
  else if (t.wallet.isConnected && marginValid && Number(margin) * (1 + leverage * feeRate) > funds + 0.005) problems.push(`Not enough USDG: you have ${money(funds)} between your wallet and the exchange.`);
  else if (type !== 'Market' && !(triggerNum > 0)) problems.push('Enter a trigger price above 0.');
  else if (type === 'Limit' && (side === 'long' ? triggerNum >= market.price : triggerNum <= market.price)) problems.push(`A ${side === 'long' ? 'buy' : 'sell'} limit must be ${side === 'long' ? 'below' : 'above'} the current price. Use Market to trade now.`);
  else if (type === 'Stop' && (side === 'long' ? triggerNum <= market.price : triggerNum >= market.price)) problems.push(`A ${side === 'long' ? 'buy' : 'sell'} stop must be ${side === 'long' ? 'above' : 'below'} the current price.`);
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
    setReview({ side, type, margin, leverage, trigger, tp: bracket ? tp : '', sl: bracket ? sl : '', days, preview, estimate: orderEstimate });
  }

  async function confirm() {
    const r = review;
    const marginUsdg = parseUsdg(r.margin);
    const address = t.wallet.address;
    const result = await t.trader.run(async (ctx) => {
      const chainNow = BigInt((await ctx.api.get('/v1/config')).chainTimeSec);
      const protect = async (kind, price) => placeOrder(ctx, protectionOrder({ kind, positionSide: r.side, marketId: market.marketId, trader: address, triggerE18: parseE18(price), validAfter: chainNow, expiry: chainNow + 30n * DAY, nonce: newNonce() }));
      if (r.type === 'Market') {
        const hash = await openTrade(ctx, { symbol, sizeDeltaE18: r.preview.sizeDeltaE18, marginUsdg });
        // The position exists now: protective orders belong to it.
        if (r.tp) await protect('takeProfit', r.tp);
        if (r.sl) await protect('stopLoss', r.sl);
        return hash;
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
    if (result.ok) {
      setReview(null);
      t.setBottomTab(r.type === 'Market' ? 'Positions' : 'Open orders');
      t.notify(r.type === 'Market' ? `${symbol} ${r.side} opened.${r.tp || r.sl ? ' Protection is set.' : ''}` : `${r.type} order placed. A keeper executes it when ${symbol} reaches ${money(Number(r.trigger), priceDigits(Number(r.trigger)))}.`);
    } else setReviewError(result.message);
  }

  const wrongNet = t.wallet.isConnected && t.wallet.wrongNetwork;
  const primary = {
    label: !t.wallet.isConnected ? 'Connect wallet' : wrongNet ? 'Switch network' : `Review ${side}`,
    arrow: t.wallet.isConnected && !wrongNet,
    disabled: t.wallet.isConnected && !wrongNet && (Boolean(primaryError) || waitingForPreview),
    error: t.wallet.isConnected && !wrongNet && marginValid ? primaryError : null,
    note: t.wallet.isConnected ? 'You approve every transaction in your wallet. Review the estimate before confirming.' : 'Connect a wallet to trade. Nothing is sent until you confirm in your wallet.',
  };
  const previewFee = shown?.fee ?? 0;

  return (
    <aside className="term-ticket">
      <div className="term-ticket-body">
        <div className="term-panel-heading"><h2>Place an order</h2><span>ISOLATED</span></div>
        <form id="term-order-form" onSubmit={openReview}>
          <div className="term-side-switch">
            <button type="button" aria-pressed={side === 'long'} className={side === 'long' ? 'active long' : ''} onClick={() => setSide('long')}>Buy / Long <Arrow /></button>
            <button type="button" aria-pressed={side === 'short'} className={side === 'short' ? 'active short' : ''} onClick={() => setSide('short')}>Sell / Short <Arrow down /></button>
          </div>
          <div className="term-order-types">
            {['Market', 'Limit', 'Stop'].map((item) => (
              <button type="button" key={item} className={type === item ? 'active' : ''} aria-pressed={type === item} onClick={() => setType(item)}>{item}</button>
            ))}
          </div>
          <div className="term-available"><span>Available</span><strong>{t.wallet.isConnected ? `${money(funds)} USDG` : '—'}</strong></div>
          {type !== 'Market' && (
            <label className="term-field">{type} price
              <div><input aria-label={`${type} order price`} type="number" min="0" step="any" value={trigger} onChange={(e) => setTrigger(e.target.value)} /><span>USDG</span></div>
            </label>
          )}
          <label className="term-field">Margin
            <div><input aria-label="Trade margin in USDG" type="number" min="0" step="0.01" value={margin} onChange={(e) => setMargin(e.target.value)} placeholder="0.00" /><span>USDG</span></div>
          </label>
          <div className="term-quick-values">
            {[50, 100, 200].map((amount) => <button type="button" key={amount} onClick={() => setMargin(String(amount))}>{amount}</button>)}
            <button type="button" onClick={setMax} disabled={!t.wallet.isConnected}>Max</button>
          </div>
          <LeverageControl value={leverage} onChange={setLeverage} max={maxLev} locked={!market.canOpen || maxLev <= 0} margin={margin} reason={!market.canOpen ? market.blockers[0] : limits && limits.maxLeverage < 3 ? `${market.statusLabel}: leverage is capped at ${limits.maxLeverage}×.` : undefined} />
          {type !== 'Market' && (
            <label className="term-field">Order stays active for
              <div><select aria-label="Order expiry" value={days} onChange={(e) => setDays(e.target.value)}>{EXPIRIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            </label>
          )}
          <label className={`term-checkbox ${type !== 'Market' ? 'is-disabled' : ''}`}>
            <input type="checkbox" checked={bracket} disabled={type !== 'Market'} onChange={(e) => setBracket(e.target.checked)} />Take profit / Stop loss <span>{type === 'Market' ? 'Optional' : 'Set after it fills'}</span>
          </label>
          {bracket && (
            <div className="term-bracket-fields">
              <label>Take profit<input aria-label="Take profit price" type="number" step="any" min="0" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="USDG" /></label>
              <label>Stop loss<input aria-label="Stop loss price" type="number" step="any" min="0" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="USDG" /></label>
            </div>
          )}
          <div className="term-order-details">
            <div><span>Order value</span><strong>{shown ? money(shown.notional) : '0.00'} USDG</strong></div>
            <div><span>{type === 'Market' ? 'Est. entry' : 'Entry at trigger'}</span><strong>{shown ? money(shown.price, priceDigits(shown.price)) : '—'}</strong></div>
            <div><span>Trade fee · {money((limits?.feeBps ?? 8) / 100, 2)}%</span><strong>{shown ? money(previewFee) : '0.00'} USDG</strong></div>
            <div><span>Est. liquidation</span><strong>{shown?.liquidation ? money(shown.liquidation, priceDigits(shown.liquidation)) : '—'}</strong></div>
            <div><span>Borrow / hour</span><strong>{limits ? `${money((limits.borrowBaseBpsPerHour ?? 0) / 100, 3)}%` : '—'} <small>base rate</small></strong></div>
          </div>
          <ReviewActions primary={primary} side={side} location="mobile" />
        </form>
        <div className="term-capacity">
          <h3>Counter capacity <button type="button" aria-label="Explain Counter capacity" onClick={() => t.setDialog({ type: 'capacity' })}>ⓘ</button></h3>
          <div><span>Long room</span><b>{limits ? money(limits.longRoom, 0) : '—'} USDG</b></div>
          <div className="term-capacity-track"><i style={{ width: `${limits ? Math.min(100, (limits.longRoom / Math.max(1, limits.positionCap * 5)) * 100) : 0}%` }} /></div>
          <div><span>Short room</span><b>{limits ? money(limits.shortRoom, 0) : '—'} USDG</b></div>
          <div className="term-capacity-track short"><i style={{ width: `${limits ? Math.min(100, (limits.shortRoom / Math.max(1, limits.positionCap * 5)) * 100) : 0}%` }} /></div>
          <p>Pool-versus-trader execution.<br />Capacity is not an order book.</p>
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

function ReviewDialog({ review: r, market, account, error, busy, step, hash, onClose, onConfirm, limits }) {
  const isMarket = r.type === 'Market';
  const p = r.preview;
  const marginNum = Number(r.margin);
  const shortfall = isMarket ? p?.shortfall ?? 0 : Math.max(0, marginNum * (1 + r.leverage * ((limits?.feeBps ?? 8) / 10_000)) - account.collateral);
  const rows = isMarket && p?.ok
    ? [['Margin', `${money(marginNum)} USDG`], ['Notional', `${money(p.notional)} USDG`], ['Estimated entry', money(p.execPrice, priceDigits(p.execPrice))], ['Trade fee', `${money(p.fee)} USDG`], ['Spread', `${p.spreadBps} bps`], ['Estimated liquidation', p.liquidation ? money(p.liquidation, priceDigits(p.liquidation)) : '—']]
    : [['Margin reserved', `${money(marginNum)} USDG`], ['Leverage', `${r.leverage}× (sized to ${ORDER_LEVERAGE_HEADROOM * 100}% for fill headroom)`], ['Trigger price', money(Number(r.trigger), priceDigits(Number(r.trigger)))], ['Active for', `${r.days} day${r.days === '1' ? '' : 's'}`]];
  return (
    <Modal title={isMarket ? 'Review order' : `Review ${r.type.toLowerCase()} order`} onClose={onClose} busy={busy}>
      <div className="term-modal-market">
        <span className="term-symbol-square">{market.symbol[0]}</span>
        <div><h3>{market.symbol} / USDG</h3><p>{r.side.toUpperCase()} · {r.type} · {r.leverage}× isolated</p></div>
      </div>
      {rows.map(([label, value]) => <div className="term-detail" key={label}><span>{label}</span><b>{value}</b></div>)}
      {r.tp && <div className="term-detail"><span>Take profit</span><b>{r.tp}</b></div>}
      {r.sl && <div className="term-detail"><span>Stop loss</span><b>{r.sl}</b></div>}
      {shortfall > 0.005 && (
        <p className="term-modal-warning">{isMarket ? `Your wallet will move about ${money(shortfall)} USDG into the exchange as part of this order (one permit signature, no separate approval).` : `This order is funded from your deposited USDG, and you have ${money(account.collateral)}. About ${money(shortfall)} USDG will be deposited from your wallet first.`}</p>
      )}
      <p className="term-modal-warning">
        {isMarket
          ? 'The price is quoted to you now and valid for about 20 seconds: confirm promptly in your wallet. Liquidation is an estimate; borrow charges accrue while the position is open.'
          : 'No transaction is sent now: you sign an order that a keeper carries out when the trigger is reached. It can be cancelled any time before then. A gap in the price can fill beyond the trigger, within the order\'s slippage limit.'}
        {r.tp || r.sl ? ' Take-profit and stop-loss each need one more signature after the position opens.' : ''}
      </p>
      <TxProgress step={step} hash={hash} />
      {error && <p className="term-form-error" role="alert">{error}</p>}
      <button className="term-primary" disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : isMarket ? `Confirm ${r.side}` : 'Sign and place order'} <Arrow down={r.side === 'short'} /></button>
    </Modal>
  );
}
