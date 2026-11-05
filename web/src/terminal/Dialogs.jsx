import React, { useMemo, useState } from 'react';
import { Arrow, Modal, TxProgress, useTerminal } from './shared.jsx';
import { friendlyError } from '../live/errors.js';
import { newNonce, protectionOrder, protectionProblem } from '../live/orders.js';
import { protectionFor, previewView, relativeTime } from '../live/model.js';
import { useClaims, usePreview, useSources } from '../live/queries.js';
import { addMarginTx, cancelOrderOnChain, cancelOrderRequest, claimPayout, closeAtMarkTx, closeTrade, depositCollateral, placeOrder, withdrawCollateral } from '../live/trade.js';
import { big, e18Num, money, parseE18, parseUsdg, priceDigits, shortAddress, usdgNum } from '../live/units.js';

const DAY = 86_400n;

/** Runs a wallet action for a dialog: closes it and says what happened, or keeps it open with the reason it failed. */
function useDialogAction(onDone) {
  const t = useTerminal();
  const [error, setError] = useState('');
  const submit = async (work, success) => {
    setError('');
    const result = await t.trader.run(work);
    if (result.ok) {
      onDone?.(result);
      if (success) t.notify(success);
    } else setError(result.message);
    return result;
  };
  return { error, setError, submit };
}

// ---------------------------------------------------------------- wallet

export function WalletDialog() {
  const t = useTerminal();
  const [error, setError] = useState('');
  const { choices, connect, connecting } = t.wallet;
  return (
    <Modal title="Connect a wallet" onClose={() => t.setDialog(null)} busy={connecting}>
      <p className="term-modal-intro">Choose the wallet you use for Robinhood Chain. PlanktonOTC never holds your keys: you approve each transaction in your wallet.</p>
      <div className="term-wallet-list">
        {choices.map((c) => (
          <button key={c.id ?? c.uid ?? c.name} disabled={connecting} onClick={async () => { setError(''); try { await connect(c); t.setDialog(null); } catch (e) { setError(friendlyError(e)); } }}>
            {c.icon ? <img src={c.icon} alt="" width="28" height="28" /> : <span className="term-wallet-glyph" aria-hidden="true">◇</span>}
            <span>{c.name}</span><Arrow />
          </button>
        ))}
        {!choices.length && <div className="term-empty">No browser wallet found.<small>Install a wallet extension such as MetaMask or Rabby, then reload this page.</small></div>}
      </div>
      {error && <p className="term-form-error" role="alert">{error}</p>}
      <p className="term-modal-warning">Wallets are detected automatically. You will be asked to switch to Robinhood Chain if you are on another network.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- account, deposits and payouts

export function AccountDialog({ account }) {
  const t = useTerminal();
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('Deposit');
  const claims = useClaims(t.wallet.address);
  const { error, setError, submit } = useDialogAction();
  const value = parseUsdg(amount);
  const limit = mode === 'Deposit' ? account.wallet : account.collateral;
  const invalid = value === null || value <= 0n ? 'Enter an amount above 0.' : usdgNum(value) > limit + 1e-9 ? (mode === 'Deposit' ? `Your wallet holds ${money(account.wallet)} USDG.` : `Only ${money(account.collateral)} USDG is free to withdraw.`) : '';
  const go = (event) => {
    event.preventDefault();
    if (invalid) return setError(invalid);
    submit((ctx) => (mode === 'Deposit' ? depositCollateral(ctx, value) : withdrawCollateral(ctx, value)), `${mode === 'Deposit' ? 'Deposited' : 'Withdrew'} ${money(usdgNum(value))} USDG.`).then((r) => r.ok && setAmount(''));
  };
  const rows = [['Wallet USDG', account.wallet], ['Deposited (free collateral)', account.collateral], ['Margin in positions', account.margin], ['Unrealised PnL', account.pnl], ['Reserved for orders', account.reserved], ['Account equity', account.equity]];
  const pending = (claims.data?.claims ?? []).filter((c) => !c.claimed);
  return (
    <Modal title="Your account" onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <div className="term-detail"><span>Wallet</span><b title={t.wallet.address}>{shortAddress(t.wallet.address)} · {t.wallet.connectorName}</b></div>
      {rows.map(([label, v]) => <div className="term-detail" key={label}><span>{label}</span><b>{money(v)} USDG</b></div>)}
      <form onSubmit={go}>
        <div className="term-switch">{['Deposit', 'Withdraw'].map((item) => <button key={item} type="button" aria-pressed={mode === item} className={mode === item ? 'active' : ''} onClick={() => { setMode(item); setError(''); }}>{item}</button>)}</div>
        <label className="term-field">{mode} amount
          <div><input type="number" min="0" step="0.01" aria-label={`${mode} amount in USDG`} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /><span>USDG</span></div>
        </label>
        <div className="term-quick-values"><button type="button" onClick={() => setAmount(String(Math.floor(limit * 100) / 100))}>Max</button></div>
        <p className="term-modal-warning">{mode === 'Deposit' ? 'One signature approves the deposit. Deposited USDG is your trading collateral: trades and orders draw on it. You rarely need to deposit by hand: placing a trade deposits what it needs.' : 'Only free collateral can be withdrawn. Margin held by open positions stays until you close them.'}</p>
        {error && <p className="term-form-error" role="alert">{error}</p>}
        <TxProgress step={t.trader.step} hash={t.trader.hash} />
        <button className="term-primary" type="submit" disabled={t.trader.busy}>{mode} USDG <Arrow /></button>
      </form>
      {pending.length > 0 && (
        <div className="term-claims">
          <h3>Deferred payouts</h3>
          <p className="term-fineprint">Profit above the hourly payout limit is paid later from the payout desk.</p>
          {pending.map((c) => (
            <div className="term-detail" key={String(c.id)}>
              <span>#{String(c.id)} · {money(usdgNum(c.amountUsdg))} USDG</span>
              {c.claimableNow
                ? <button className="term-mini-btn" disabled={t.trader.busy} onClick={() => submit((ctx) => claimPayout(ctx, c.id), `Claimed ${money(usdgNum(c.amountUsdg))} USDG.`)}>Claim</button>
                : <b className="term-muted">{relativeTime(Number(big(c.claimableAt)) * 1000)}</b>}
            </div>
          ))}
        </div>
      )}
      <div className="term-modal-actions"><button className="term-secondary" type="button" onClick={async () => { await t.wallet.disconnect(); t.setDialog(null); }}>Disconnect wallet</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- closing

export function CloseDialog({ symbol, percent: start, account, market }) {
  const t = useTerminal();
  const position = account.positions.find((p) => p.symbol === symbol);
  const [percent, setPercent] = useState(start);
  const [fallback, setFallback] = useState(false);
  const { error, submit } = useDialogAction(() => t.setDialog(null));
  const params = useMemo(() => (position ? { market: symbol, trader: t.wallet.address, sizeBps: percent * 100 } : null), [position, symbol, t.wallet.address, percent]);
  const preview = previewView(usePreview(params).data);
  if (!position) return <Modal title="Close position" onClose={() => t.setDialog(null)}><p className="term-modal-intro">This position is already closed.</p></Modal>;
  const go = async () => {
    const result = await submit((ctx) => closeTrade(ctx, { symbol, sizeBps: percent * 100 }), `${percent === 100 ? 'Closed' : `Trimmed ${percent}% of`} ${symbol}.`);
    if (!result.ok && result.error?.body?.closeAtMark) setFallback(true);
  };
  return (
    <Modal title={percent === 100 ? 'Close position' : 'Trim position'} onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <div className="term-modal-market"><span className="term-symbol-square">{symbol[0]}</span><div><h3>{symbol} / USDG</h3><p>{position.side.toUpperCase()} · {money(position.margin)} USDG margin</p></div></div>
      <label className="term-leverage-label" htmlFor="term-close-size">Close size <strong>{percent}%</strong></label>
      <input id="term-close-size" className="term-range" type="range" min="1" max="100" value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
      <div className="term-quick-values">{[25, 50, 75, 100].map((v) => <button type="button" key={v} onClick={() => setPercent(v)}>{v}%</button>)}</div>
      {preview?.ok && (
        <>
          <div className="term-detail"><span>Estimated exit price</span><b>{money(preview.execPrice, priceDigits(preview.execPrice))}</b></div>
          <div className="term-detail"><span>Trade fee</span><b>{money(preview.fee)} USDG</b></div>
          <div className="term-detail"><span>Spread</span><b>{preview.spreadBps} bps</b></div>
        </>
      )}
      {preview && !preview.ok && <p className="term-form-error" role="status">{friendlyError({ name: 'ApiError', status: 422, message: preview.code, body: { code: preview.code, message: preview.message } })}</p>}
      <p className="term-modal-warning">The exit price is quoted just before you confirm and is valid for up to 60 seconds. Profit above the payout limit may be paid late through the payout desk.</p>
      {fallback && <p className="term-form-error" role="alert">The quote service cannot price this right now. You can still exit at the on-chain mark.</p>}
      <TxProgress step={t.trader.step} hash={t.trader.hash} />
      {error && !fallback && <p className="term-form-error" role="alert">{error}</p>}
      <div className="term-modal-actions">
        {fallback && <button className="term-secondary" onClick={() => t.setDialog({ type: 'close-at-mark', symbol, percent })}>Close at mark instead</button>}
        <button className="term-primary" disabled={t.trader.busy} onClick={go}>{percent === 100 ? 'Close position' : `Trim ${percent}%`} <Arrow /></button>
      </div>
    </Modal>
  );
}

export function CloseAtMarkDialog({ symbol, percent: start = 100, account, market }) {
  const t = useTerminal();
  const position = account.positions.find((p) => p.symbol === symbol);
  const [percent, setPercent] = useState(start);
  const { error, submit } = useDialogAction(() => t.setDialog(null));
  if (!position) return <Modal title="Close at mark" onClose={() => t.setDialog(null)}><p className="term-modal-intro">This position is already closed.</p></Modal>;
  return (
    <Modal title="Close at mark" onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <p className="term-modal-intro">The permissionless exit. It needs no price quote and no PlanktonOTC service: the contract settles your position at its own on-chain mark.</p>
      <div className="term-modal-market"><span className="term-symbol-square">{symbol[0]}</span><div><h3>{symbol} / USDG</h3><p>{position.side.toUpperCase()} · {money(position.notional)} USDG exposure</p></div></div>
      <label className="term-leverage-label" htmlFor="term-mark-size">Close size <strong>{percent}%</strong></label>
      <input id="term-mark-size" className="term-range" type="range" min="1" max="100" value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
      <div className="term-quick-values">{[25, 50, 75, 100].map((v) => <button type="button" key={v} onClick={() => setPercent(v)}>{v}%</button>)}</div>
      <div className="term-detail"><span>On-chain mark</span><b>{money(position.mark, priceDigits(position.mark))}</b></div>
      <div className="term-detail"><span>Market state</span><b>{market?.statusLabel ?? '—'}</b></div>
      <p className="term-modal-warning">The on-chain mark can be held or stale, and a wider spread applies. If it is stale, losses settle but profit may not be paid. Use this when the normal close is unavailable.</p>
      <TxProgress step={t.trader.step} hash={t.trader.hash} />
      {error && <p className="term-form-error" role="alert">{error}</p>}
      <button className="term-primary" disabled={t.trader.busy} onClick={() => submit((ctx) => closeAtMarkTx(ctx, { marketId: position.marketId, sizeBps: percent * 100 }), `Closed ${percent}% of ${symbol} at the on-chain mark.`)}>Close {percent}% at mark <Arrow /></button>
    </Modal>
  );
}

// ---------------------------------------------------------------- margin and protection

export function MarginDialog({ symbol, account }) {
  const t = useTerminal();
  const position = account.positions.find((p) => p.symbol === symbol);
  const [amount, setAmount] = useState('50');
  const { error, setError, submit } = useDialogAction(() => t.setDialog(null));
  if (!position) return <Modal title="Add margin" onClose={() => t.setDialog(null)}><p className="term-modal-intro">This position is already closed.</p></Modal>;
  const value = parseUsdg(amount);
  const go = (event) => {
    event.preventDefault();
    if (value === null || value <= 0n) return setError('Enter an amount above 0.');
    if (usdgNum(value) > account.available + 1e-9) return setError(`You have ${money(account.available)} USDG between your wallet and the exchange.`);
    submit((ctx) => addMarginTx(ctx, { marketId: position.marketId, amountUsdg: value, collateralUsdg: BigInt(Math.floor(account.collateral * 1e6)) }), `Added ${money(usdgNum(value))} USDG margin to ${symbol}.`);
  };
  return (
    <Modal title={`Add margin · ${symbol}`} onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <form onSubmit={go}>
        <div className="term-detail"><span>Current margin</span><b>{money(position.margin)} USDG</b></div>
        <div className="term-detail"><span>Deposited collateral</span><b>{money(account.collateral)} USDG</b></div>
        <div className="term-detail"><span>Wallet USDG</span><b>{money(account.wallet)} USDG</b></div>
        <label className="term-field">Additional margin
          <div><input aria-label="Additional position margin" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /><span>USDG</span></div>
        </label>
        <p className="term-modal-warning">More margin lowers your effective leverage and moves the liquidation price away. The position size does not change. Anything not already deposited is deposited from your wallet first.</p>
        {error && <p className="term-form-error" role="alert">{error}</p>}
        <TxProgress step={t.trader.step} hash={t.trader.hash} />
        <button className="term-primary" type="submit" disabled={t.trader.busy}>Add margin +</button>
      </form>
    </Modal>
  );
}

export function ProtectionDialog({ symbol, account, orders, market }) {
  const t = useTerminal();
  const position = account.positions.find((p) => p.symbol === symbol);
  const current = protectionFor(symbol, orders);
  const digits = priceDigits(market?.price ?? 1);
  const [tp, setTp] = useState(current.takeProfit ? String(current.takeProfit.trigger) : '');
  const [sl, setSl] = useState(current.stopLoss ? String(current.stopLoss.trigger) : '');
  const { error, setError, submit } = useDialogAction(() => t.setDialog(null));
  if (!position) return <Modal title="Position protection" onClose={() => t.setDialog(null)}><p className="term-modal-intro">Open a position first: take-profit and stop-loss orders protect an existing position.</p></Modal>;
  const save = (event) => {
    event.preventDefault();
    const issue = protectionProblem(position.side, position.mark, tp, sl);
    if (issue) return setError(issue);
    submit(async (ctx) => {
      const now = BigInt((await ctx.api.get('/v1/config')).chainTimeSec);
      // A changed or cleared level cancels its old order first, so two exits never race.
      for (const [kind, text, existing] of [['takeProfit', tp, current.takeProfit], ['stopLoss', sl, current.stopLoss]]) {
        const unchanged = existing && text !== '' && Number(text) === existing.trigger;
        if (existing && !unchanged) await cancelOrderRequest(ctx, existing.nonce);
        if (text !== '' && !unchanged) {
          await placeOrder(ctx, protectionOrder({ kind, positionSide: position.side, marketId: position.marketId, trader: ctx.address, triggerE18: parseE18(text), validAfter: now, expiry: now + 30n * DAY, nonce: newNonce() }));
        }
      }
    }, 'Protection saved. A keeper closes the position if either level is reached.');
  };
  return (
    <Modal title={`Position protection · ${symbol}`} onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <form onSubmit={save}>
        <div className="term-detail"><span>Current mark</span><b>{money(position.mark, digits)} USDG</b></div>
        <div className="term-detail"><span>Applies to</span><b>Your whole {position.side.toUpperCase()} position</b></div>
        <div className="term-protection-form">
          <label className="term-field">Take-profit trigger<div><input aria-label="Position take profit trigger" type="number" min="0" step="any" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="Optional" /><span>USDG</span></div></label>
          <label className="term-field">Stop-loss trigger<div><input aria-label="Position stop loss trigger" type="number" min="0" step="any" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="Optional" /><span>USDG</span></div></label>
        </div>
        <p className="term-modal-warning">Each level is a signed order that closes the whole position when the mark reaches it; it can only reduce, never open or reverse. A keeper carries it out, so a fast gap or an unavailable quote can fill beyond the trigger or delay it. It lapses after 30 days and when the position closes. Each changed level asks for one signature.</p>
        {error && <p className="term-form-error" role="alert">{error}</p>}
        <TxProgress step={t.trader.step} hash={t.trader.hash} />
        <div className="term-modal-actions">
          <button className="term-secondary" type="button" disabled={t.trader.busy} onClick={() => { setTp(''); setSl(''); }}>Clear levels</button>
          <button className="term-primary" type="submit" disabled={t.trader.busy}>Save protection <Arrow /></button>
        </div>
      </form>
    </Modal>
  );
}

export function CancelOrderDialog({ nonce, orders }) {
  const t = useTerminal();
  const order = orders.find((o) => o.nonceText === nonce);
  const [onChain, setOnChain] = useState(false);
  const { error, submit } = useDialogAction(() => t.setDialog(null));
  if (!order) return <Modal title="Cancel order" onClose={() => t.setDialog(null)}><p className="term-modal-intro">This order is no longer open.</p></Modal>;
  return (
    <Modal title="Cancel order" onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <div className="term-detail"><span>Order</span><b>{order.symbol} · {order.label}{order.side ? ` · ${order.side.toUpperCase()}` : ''}</b></div>
      <div className="term-detail"><span>Trigger</span><b>{order.triggerAbove ? '≥' : '≤'} {money(order.trigger, priceDigits(order.trigger))}</b></div>
      <p className="term-modal-warning">Cancelling asks for a free signature and removes the order from the queue at once. {order.protective ? 'Your position is then no longer protected by this level.' : 'Reserved margin is released.'}</p>
      <label className="term-checkbox"><input type="checkbox" checked={onChain} onChange={(e) => setOnChain(e.target.checked)} />Also cancel on-chain <span>costs gas</span></label>
      <p className="term-fineprint">The on-chain cancel is the only one that also stops a keeper that has already picked the order up. Use it for an order that is about to trigger.</p>
      <TxProgress step={t.trader.step} hash={t.trader.hash} />
      {error && <p className="term-form-error" role="alert">{error}</p>}
      <button className="term-primary" disabled={t.trader.busy} onClick={() => submit(async (ctx) => { await cancelOrderRequest(ctx, order.nonce); if (onChain) await cancelOrderOnChain(ctx, order.nonce); }, 'Order cancelled.')}>Cancel order</button>
    </Modal>
  );
}

export function RiskDialog({ symbol, account }) {
  const t = useTerminal();
  const p = account.positions.find((x) => x.symbol === symbol);
  if (!p) return <Modal title="Isolated margin" onClose={() => t.setDialog(null)}><p className="term-modal-intro">No open position in {symbol}.</p></Modal>;
  const digits = priceDigits(p.mark || p.entry);
  const rows = [['Position equity', `${money(p.equity)} USDG`], [`Maintenance · ${money(p.maintenanceBps / 100, 1)}%`, `${money(p.maintenance)} USDG`], ['Equity above maintenance', `${money(p.buffer)} USDG`], ['Gross exposure', `${money(p.notional)} USDG`], ['Estimated liquidation price', p.liquidation === null ? '—' : money(p.liquidation, digits)], ['Distance to estimated liquidation', p.distancePercent === null ? '—' : `${money(p.distancePercent, 1)}%`], ['Effective leverage', Number.isFinite(p.effectiveLeverage) ? `${money(p.effectiveLeverage, 2)}×` : 'No positive equity'], ['Entry / mark', `${money(p.entry, digits)} / ${money(p.mark, digits)}`]];
  return (
    <Modal title={`Isolated margin · ${symbol}`} onClose={() => t.setDialog(null)}>
      <div className="term-risk-modal-score"><strong>{money(p.healthPercent, 1)}%</strong><span>Buffer ratio<small>{p.status}</small></span></div>
      {rows.map(([label, value]) => <div className="term-detail" key={label}><span>{label}</span><b>{value}</b></div>)}
      <p className="term-modal-warning">Buffer ratio = (position equity − maintenance) / position equity. The liquidation price is an estimate from the contract's maintenance rate. Borrow accrued since opening, settled on-chain, moves the real level closer.</p>
      <div className="term-modal-actions">
        <button className="term-secondary" onClick={() => t.setDialog({ type: 'protection', symbol })}>Edit TP / SL</button>
        <button className="term-primary" onClick={() => t.setDialog({ type: 'margin', symbol })}>Add margin +</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- information

export function SourcesDialog({ market }) {
  const t = useTerminal();
  const q = useSources(market.symbol, true);
  const s = q.data;
  const labels = { chainlink: 'Chainlink equity feed', rh_quote: 'Robinhood Stock Token quote', pyth: 'Pyth', uni_v3: 'Uniswap v3 pool', uni_v4: 'Uniswap v4 pool' };
  return (
    <Modal title="Why this mark?" onClose={() => t.setDialog(null)}>
      <p className="term-modal-intro">Every mark is signed by independent signers. Where Chainlink has a feed for the stock, it must agree with Robinhood's quote before a new position can open; stocks without a feed are priced from Robinhood's quote alone. If sources disagree or go stale, opens stop and exits stay available.</p>
      <div className="term-detail"><span>Market state</span><b>{market.statusLabel}</b></div>
      <div className="term-detail"><span>Mark</span><b>{market.price ? money(market.price, priceDigits(market.price)) : '—'} USDG</b></div>
      <div className="term-detail"><span>Source agreement</span><b>{market.dispersionBps === null ? '—' : `${market.dispersionBps} bps apart`}</b></div>
      {q.isLoading && <div className="term-empty">Loading sources…</div>}
      {q.isError && <p className="term-form-error" role="status">The price service did not answer. {friendlyError(q.error)}</p>}
      {s?.sources?.map((row) => (
        <div className="term-source-row" key={row.source}>
          <div><strong>{labels[row.source] ?? row.source}</strong><small>updated {Math.round(row.ageMs / 1000)}s ago</small></div>
          <b>{money(e18Num(row.priceE18), priceDigits(e18Num(row.priceE18)))}</b>
        </div>
      ))}
      {s && !s.sources?.length && <div className="term-empty">No source has reported a price yet.</div>}
      {s?.halted && <p className="term-modal-warning">Trading in this stock is halted{s.haltReason ? ` (${s.haltReason})` : ''}. New positions are stopped; exits stay available.</p>}
      {market.freezeReasons.length > 0 && <p className="term-modal-warning">Frozen: {market.freezeReasons.join(', ')}.</p>}
      {market.warnings.length > 0 && <p className="term-modal-warning">Listing check: {market.warnings.join('; ')}.</p>}
      <a className="term-primary term-link-btn" href="/docs?topic=mechanics">Read the pricing method <Arrow /></a>
    </Modal>
  );
}

export function CapacityDialog({ market }) {
  const t = useTerminal();
  const l = market.limits;
  return (
    <Modal title="Size follows the loss budget" onClose={() => t.setDialog(null)}>
      <p className="term-modal-intro">The Counter, a shared pool, takes the other side of every trade, so each market can only carry so much. These figures come from the contract, right now.</p>
      {l ? <>
        <div className="term-detail"><span>Counter NAV</span><b>{money(l.nav, 0)} USDG</b></div>
        <div className="term-detail"><span>Largest single position</span><b>{money(l.positionCap, 0)} USDG</b></div>
        <div className="term-detail"><span>Room to go long</span><b>{money(l.longRoom, 0)} USDG</b></div>
        <div className="term-detail"><span>Room to go short</span><b>{money(l.shortRoom, 0)} USDG</b></div>
        <div className="term-detail"><span>Open interest long / short</span><b>{money(l.longOi, 0)} / {money(l.shortOi, 0)} USDG</b></div>
      </> : <div className="term-empty">Limits are unavailable right now.</div>}
      <p className="term-modal-warning">More leverage does not raise the position cap. Room shrinks as the Counter takes on one-sided exposure, and grows as it is balanced.</p>
      <button className="term-primary" onClick={() => { t.setDialog(null); t.changeView('Counter'); }}>Explore the Counter <Arrow /></button>
    </Modal>
  );
}

export function AlertDialog({ market }) {
  const t = useTerminal();
  const [direction, setDirection] = useState('Above');
  const [price, setPrice] = useState(market.price ? market.price.toFixed(priceDigits(market.price)) : '');
  return (
    <Modal title="Create a price alert" onClose={() => t.setDialog(null)}>
      <form onSubmit={(event) => {
        event.preventDefault();
        const value = Number(price);
        if (!Number.isFinite(value) || value <= 0) return t.notify('Enter a valid alert price.');
        t.addAlert({ id: Date.now(), symbol: market.symbol, direction, price: value });
        t.setDialog(null);
        t.notify(`Alert saved. You will be told here when ${market.symbol} goes ${direction.toLowerCase()} ${money(value, priceDigits(value))}.`);
      }}>
        <div className="term-detail"><span>Market</span><b>{market.symbol} / USDG</b></div>
        <label className="term-field">Condition<div><select aria-label="Alert direction" value={direction} onChange={(e) => setDirection(e.target.value)}><option>Above</option><option>Below</option></select></div></label>
        <label className="term-field">Trigger price<div><input type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} required /><span>USDG</span></div></label>
        <p className="term-modal-warning">Alerts live in this browser and fire only while this page is open. They do not send email, Telegram or webhook messages.</p>
        <button className="term-primary" type="submit">Save alert +</button>
      </form>
    </Modal>
  );
}

export function ShortcutsDialog() {
  const t = useTerminal();
  return (
    <Modal title="Move through your workspace" onClose={() => t.setDialog(null)}>
      <p className="term-modal-intro">Shortcuts select controls; they never submit a trade.</p>
      <div className="term-shortcut-list">
        {[['Ctrl / ⌘ K or /', 'Search markets and workspaces'], ['F', 'Toggle focus layout'], ['B / S', 'Choose Long / Short'], ['?', 'Open this shortcut guide'], ['Escape', 'Close dialog or exit focus']].map(([keys, action]) => <div key={keys}><span>{action}</span><kbd>{keys}</kbd></div>)}
      </div>
    </Modal>
  );
}

export function CommandMenu({ markets }) {
  const t = useTerminal();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const choices = [
    ...markets.map((m) => ({ title: `${m.symbol} / USDG`, detail: m.name, action: () => t.chooseMarket(m.symbol) })),
    ...['Trade', 'Counter', 'Tape', 'Ledger', 'Rewards'].map((view) => ({ title: `Go to ${view}`, detail: 'Workspace', action: () => { t.changeView(view); t.setDialog(null); } })),
  ].filter((item) => `${item.title} ${item.detail}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <Modal title="Jump to a market or workspace" onClose={() => t.setDialog(null)}>
      <div className="term-command-search">
        <span>⌕</span>
        <input autoFocus aria-label="Search commands and markets" placeholder="Search symbol, company or workspace…" value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) e.preventDefault();
            if (e.key === 'ArrowDown') setIndex((v) => Math.min(choices.length - 1, v + 1));
            if (e.key === 'ArrowUp') setIndex((v) => Math.max(0, v - 1));
            if (e.key === 'Enter') choices[index]?.action();
          }} />
      </div>
      <div className="term-command-results">
        {choices.map((item, i) => <button key={item.title} className={index === i ? 'active' : ''} onClick={item.action}><span><b>{item.title}</b><small>{item.detail}</small></span><span>↵</span></button>)}
        {!choices.length && <p>No matching market or workspace.</p>}
      </div>
      <p className="term-command-help">↑ ↓ Navigate · Enter select · Esc close</p>
    </Modal>
  );
}
