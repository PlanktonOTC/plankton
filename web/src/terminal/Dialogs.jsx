import React, { useMemo, useState } from 'react';
import { Arrow, Modal, TxProgress, useTerminal } from './shared.jsx';
import { PresetControls, usePresets } from './Presets.jsx';
import { presetLevels } from '../live/presets.js';
import { friendlyError, isUserRejection } from '../live/errors.js';
import { marketCloseOrder, newNonce, protectionOrder, protectionProblem } from '../live/orders.js';
import { protectionFor, previewView, relativeTime } from '../live/model.js';
import { useClaims, usePreview, useSources } from '../live/queries.js';
import { addMarginTx, cancelOrderOnChain, cancelOrderRequest, claimPayout, closeAtMarkTx, depositCollateral, gaslessOrder, placeOrder, withdrawCollateral } from '../live/trade.js';
import { big, e18Num, money, parseE18, parseUsdg, priceDigits, shortAddress, usdgNum } from '../live/units.js';
import { useI18n } from '../i18n';

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

const ICONS = {
  email: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></svg>,
  passkey: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H6a2 2 0 0 0-2 2v2M16 4h2a2 2 0 0 1 2 2v2M8 20H6a2 2 0 0 1-2-2v-2M16 20h2a2 2 0 0 0 2-2v-2" /><path d="M9 9v1M15 9v1M12 9v4h-1M9.5 15.5a3.5 3.5 0 0 0 5 0" /></svg>,
  google: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12.2c0-.6-.1-1.2-.2-1.7H12v3.3h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.6-3.9 2.6-6.5Z" /><path d="M12 21c2.4 0 4.5-.8 5.9-2.2L15 16.6c-.8.5-1.8.9-3 .9a5.2 5.2 0 0 1-4.9-3.6H4.1v2.3A9 9 0 0 0 12 21Z" /><path d="M7.1 13.9a5.4 5.4 0 0 1 0-3.5V8.1h-3a9 9 0 0 0 0 8.1l3-2.3Z" /><path d="M12 6.5c1.3 0 2.5.5 3.4 1.3L18 5.3A9 9 0 0 0 4.1 8.1l3 2.3A5.2 5.2 0 0 1 12 6.5Z" /></svg>,
  wallet: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7a2 2 0 0 1 2-2h11v4" /><rect x="4" y="7" width="16" height="12" rx="2.5" /><path d="M16 13h2" /></svg>,
};

/** Three short promises instead of a paragraph: what signing in here does and does not mean. */
function TrustStrip() {
  const { t: tr } = useI18n();
  return (
    <ul className="term-connect-trust">
      <li><b>{tr('Self-custody')}</b><span>{tr('Plankton never holds your keys')}</span></li>
      <li><b>{tr('Gas-free trades')}</b><span>{tr('after one USDG deposit')}</span></li>
      <li><b>{tr('You approve')}</b><span>{tr('every signature, every time')}</span></li>
    </ul>
  );
}

export function WalletDialog() {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const [error, setError] = useState('');
  const { choices, connect, connecting, login, privyReady } = t.wallet;
  const start = (methods) => { t.setDialog(null); login(methods); };

  if (login) {
    const tiles = [
      { key: 'email', title: 'Email', detail: 'One-time code' },
      { key: 'passkey', title: 'Passkey', detail: 'Face ID or Touch ID' },
      { key: 'google', title: 'Google', detail: 'Your Google account' },
    ];
    return (
      <Modal title={tr('Sign in to Plankton')} onClose={() => t.setDialog(null)}>
        <p className="term-connect-lead">{tr('New here? Pick one and a Robinhood Chain wallet is made for you. No extension, no seed phrase.')}</p>
        <div className="term-connect-tiles">
          {tiles.map((x) => (
            <button key={x.key} className={`term-connect-tile is-${x.key}`} disabled={!privyReady} onClick={() => start([x.key])}>
              <span className="term-connect-icon">{ICONS[x.key]}</span>
              <b>{tr(x.title)}</b>
              <small>{tr(x.detail)}</small>
            </button>
          ))}
        </div>
        <div className="term-connect-divider"><span>{tr('or use a wallet you have')}</span></div>
        <button className="term-connect-row" disabled={!privyReady} onClick={() => start(['wallet'])}>
          <span className="term-connect-icon">{ICONS.wallet}</span>
          <span><b>{tr('Browser or mobile wallet')}</b><small>{tr('MetaMask, Rabby, Coinbase Wallet and more')}</small></span>
          <Arrow />
        </button>
        {!privyReady && <p className="term-connect-loading" role="status">{tr('Loading sign-in…')}</p>}
        <TrustStrip />
      </Modal>
    );
  }

  return (
    <Modal title={tr('Connect a wallet')} onClose={() => t.setDialog(null)} busy={connecting}>
      <p className="term-connect-lead">{tr('Choose the wallet you use for Robinhood Chain. You will be asked to switch network if needed.')}</p>
      <div className="term-connect-list">
        {choices.map((c, i) => (
          <button key={c.id ?? c.uid ?? c.name} className="term-connect-row" disabled={connecting} onClick={async () => { setError(''); try { await connect(c); t.setDialog(null); } catch (e) { setError(friendlyError(e)); } }}>
            <span className="term-connect-icon">{c.icon ? <img src={c.icon} alt="" width="26" height="26" /> : ICONS.wallet}</span>
            <span><b>{c.name}</b><small>{tr(c.id === 'injected' ? 'Browser wallet' : 'Detected in this browser')}</small></span>
            {i === 0 && c.id !== 'injected' ? <em className="term-connect-tag">{tr('Installed')}</em> : <Arrow />}
          </button>
        ))}
        {!choices.length && (
          <div className="term-connect-empty">
            <span className="term-connect-icon">{ICONS.wallet}</span>
            <b>{tr('No wallet found in this browser')}</b>
            <small>{tr('Install one, then reload this page.')}</small>
            <div><a href="https://metamask.io/download/" target="_blank" rel="noreferrer">{tr('Get MetaMask')} <Arrow /></a><a href="https://rabby.io/" target="_blank" rel="noreferrer">{tr('Get Rabby')} <Arrow /></a></div>
          </div>
        )}
      </div>
      {error && <p className="term-form-error" role="alert">{tr(error)}</p>}
      <TrustStrip />
    </Modal>
  );
}

// ---------------------------------------------------------------- account, deposits and payouts

export function AccountDialog({ account }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
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
    <Modal title={tr('Your account')} onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <div className="term-detail"><span>{tr('Wallet')}</span><b title={t.wallet.address}>{shortAddress(t.wallet.address)} · {t.wallet.connectorName}</b></div>
      {rows.map(([label, v]) => <div className="term-detail" key={label}><span>{tr(label)}</span><b>{money(v)} USDG</b></div>)}
      <form onSubmit={go}>
        <div className="term-switch">{['Deposit', 'Withdraw'].map((item) => <button key={item} type="button" aria-pressed={mode === item} className={mode === item ? 'active' : ''} onClick={() => { setMode(item); setError(''); }}>{tr(item)}</button>)}</div>
        <label className="term-field">{tr('{mode} amount', { mode: tr(mode) })}
          <div><input type="number" min="0" step="0.01" aria-label={tr('{mode} amount in USDG', { mode: tr(mode) })} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /><span>USDG</span></div>
        </label>
        <div className="term-quick-values"><button type="button" onClick={() => setAmount(String(Math.floor(limit * 100) / 100))}>{tr('Max')}</button></div>
        <p className="term-modal-warning">{tr(mode === 'Deposit' ? 'One signature approves the deposit. Deposited USDG is your trading collateral: trades and orders draw on it. You rarely need to deposit by hand: placing a trade deposits what it needs.' : 'Only free collateral can be withdrawn. Margin held by open positions stays until you close them.')}</p>
        {error && <p className="term-form-error" role="alert">{tr(error)}</p>}
        <TxProgress step={t.trader.step} hash={t.trader.hash} />
        <button className="term-primary" type="submit" disabled={t.trader.busy}>{tr('{mode} USDG', { mode: tr(mode) })} <Arrow /></button>
      </form>
      {pending.length > 0 && (
        <div className="term-claims">
          <h3>{tr('Deferred payouts')}</h3>
          <p className="term-fineprint">{tr('Profit above the hourly payout limit is paid later from the payout desk.')}</p>
          {pending.map((c) => (
            <div className="term-detail" key={String(c.id)}>
              <span>#{String(c.id)} · {money(usdgNum(c.amountUsdg))} USDG</span>
              {c.claimableNow
                ? <button className="term-mini-btn" disabled={t.trader.busy} onClick={() => submit((ctx) => claimPayout(ctx, c.id), `Claimed ${money(usdgNum(c.amountUsdg))} USDG.`)}>{tr('Claim')}</button>
                : <b className="term-muted">{tr(relativeTime(Number(big(c.claimableAt)) * 1000))}</b>}
            </div>
          ))}
        </div>
      )}
      <div className="term-modal-actions"><button className="term-secondary" type="button" onClick={async () => { await t.wallet.disconnect(); t.setDialog(null); }}>{tr('Disconnect wallet')}</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- closing

export function CloseDialog({ symbol, percent: start, account, market }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const position = account.positions.find((p) => p.symbol === symbol);
  const [percent, setPercent] = useState(start);
  const [fallback, setFallback] = useState(false);
  const { error, submit } = useDialogAction(() => t.setDialog(null));
  const params = useMemo(() => (position ? { market: symbol, trader: t.wallet.address, sizeBps: percent * 100 } : null), [position, symbol, t.wallet.address, percent]);
  const preview = previewView(usePreview(params).data);
  if (!position) return <Modal title={tr('Close position')} onClose={() => t.setDialog(null)}><p className="term-modal-intro">{tr('This position is already closed.')}</p></Modal>;
  const go = async () => {
    // Gasless: the trader signs a reduce-only market order and the keeper closes it, paying the gas. If that cannot
    // happen (quote service down, market frozen), the permissionless exit at the on-chain mark is offered instead.
    const result = await submit(async (ctx) => {
      const chainNow = BigInt((await ctx.api.get('/v1/config')).chainTimeSec);
      return gaslessOrder(ctx, marketCloseOrder({ marketId: position.marketId, trader: ctx.address, sizeBps: percent * 100, validAfter: chainNow, nonce: newNonce() }));
    }, `${percent === 100 ? 'Closed' : `Trimmed ${percent}% of`} ${symbol}.`);
    if (!result.ok && !isUserRejection(result.error)) setFallback(true);
  };
  return (
    <Modal title={tr(percent === 100 ? 'Close position' : 'Trim position')} onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <div className="term-modal-market"><span className="term-symbol-square">{symbol[0]}</span><div><h3>{symbol} / USDG</h3><p>{tr(position.side.toUpperCase())} · {tr('{amount} USDG margin', { amount: money(position.margin) })}</p></div></div>
      <label className="term-leverage-label" htmlFor="term-close-size">{tr('Close size')} <strong>{percent}%</strong></label>
      <input id="term-close-size" className="term-range" type="range" min="1" max="100" value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
      <div className="term-quick-values">{[25, 50, 75, 100].map((v) => <button type="button" key={v} onClick={() => setPercent(v)}>{v}%</button>)}</div>
      {preview?.ok && (
        <>
          <div className="term-detail"><span>{tr('Estimated exit price')}</span><b>{money(preview.execPrice, priceDigits(preview.execPrice))}</b></div>
          <div className="term-detail"><span>{tr('Trade fee')}</span><b>{money(preview.fee)} USDG</b></div>
          <div className="term-detail"><span>{tr('Spread')}</span><b>{preview.spreadBps} bps</b></div>
        </>
      )}
      {preview && !preview.ok && <p className="term-form-error" role="status">{tr(friendlyError({ name: 'ApiError', status: 422, message: preview.code, body: { code: preview.code, message: preview.message } }))}</p>}
      <p className="term-modal-warning">{tr('Gasless: you sign one message and a keeper closes the position within a few seconds, paying the gas. The exit price is quoted at the fill. Profit above the payout limit may be paid late through the payout desk.')}</p>
      {fallback && <p className="term-form-error" role="alert">{tr('The quote service cannot price this right now. You can still exit at the on-chain mark.')}</p>}
      <TxProgress step={t.trader.step} hash={t.trader.hash} />
      {error && !fallback && <p className="term-form-error" role="alert">{tr(error)}</p>}
      <div className="term-modal-actions">
        {fallback && <button className="term-secondary" onClick={() => t.setDialog({ type: 'close-at-mark', symbol, percent })}>{tr('Close at mark instead')}</button>}
        <button className="term-primary" disabled={t.trader.busy} onClick={go}>{tr(percent === 100 ? 'Close position' : `Trim ${percent}%`)} <Arrow /></button>
      </div>
    </Modal>
  );
}

export function CloseAtMarkDialog({ symbol, percent: start = 100, account, market }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const position = account.positions.find((p) => p.symbol === symbol);
  const [percent, setPercent] = useState(start);
  const { error, submit } = useDialogAction(() => t.setDialog(null));
  if (!position) return <Modal title={tr('Close at mark')} onClose={() => t.setDialog(null)}><p className="term-modal-intro">{tr('This position is already closed.')}</p></Modal>;
  return (
    <Modal title={tr('Close at mark')} onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <p className="term-modal-intro">{tr('The permissionless exit. It needs no price quote and no PlanktonOTC service: the contract settles your position at its own on-chain mark.')}</p>
      <div className="term-modal-market"><span className="term-symbol-square">{symbol[0]}</span><div><h3>{symbol} / USDG</h3><p>{tr(position.side.toUpperCase())} · {tr('{amount} USDG exposure', { amount: money(position.notional) })}</p></div></div>
      <label className="term-leverage-label" htmlFor="term-mark-size">{tr('Close size')} <strong>{percent}%</strong></label>
      <input id="term-mark-size" className="term-range" type="range" min="1" max="100" value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
      <div className="term-quick-values">{[25, 50, 75, 100].map((v) => <button type="button" key={v} onClick={() => setPercent(v)}>{v}%</button>)}</div>
      <div className="term-detail"><span>{tr('On-chain mark')}</span><b>{money(position.mark, priceDigits(position.mark))}</b></div>
      <div className="term-detail"><span>{tr('Market state')}</span><b>{market?.statusLabel ? tr(market.statusLabel) : '—'}</b></div>
      <p className="term-modal-warning">{tr('The on-chain mark can be held or stale, and a wider spread applies. If it is stale, losses settle but profit may not be paid. Use this when the normal close is unavailable.')}</p>
      <TxProgress step={t.trader.step} hash={t.trader.hash} />
      {error && <p className="term-form-error" role="alert">{tr(error)}</p>}
      <button className="term-primary" disabled={t.trader.busy} onClick={() => submit((ctx) => closeAtMarkTx(ctx, { marketId: position.marketId, sizeBps: percent * 100 }), `Closed ${percent}% of ${symbol} at the on-chain mark.`)}>{tr('Close {pct}% at mark', { pct: percent })} <Arrow /></button>
    </Modal>
  );
}

// ---------------------------------------------------------------- margin and protection

export function MarginDialog({ symbol, account }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const position = account.positions.find((p) => p.symbol === symbol);
  const [amount, setAmount] = useState('50');
  const { error, setError, submit } = useDialogAction(() => t.setDialog(null));
  if (!position) return <Modal title={tr('Add margin')} onClose={() => t.setDialog(null)}><p className="term-modal-intro">{tr('This position is already closed.')}</p></Modal>;
  const value = parseUsdg(amount);
  const go = (event) => {
    event.preventDefault();
    if (value === null || value <= 0n) return setError('Enter an amount above 0.');
    if (usdgNum(value) > account.available + 1e-9) return setError(`You have ${money(account.available)} USDG between your wallet and the exchange.`);
    submit((ctx) => addMarginTx(ctx, { marketId: position.marketId, amountUsdg: value, collateralUsdg: BigInt(Math.floor(account.collateral * 1e6)) }), `Added ${money(usdgNum(value))} USDG margin to ${symbol}.`);
  };
  return (
    <Modal title={tr(`Add margin · ${symbol}`)} onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <form onSubmit={go}>
        <div className="term-detail"><span>{tr('Current margin')}</span><b>{money(position.margin)} USDG</b></div>
        <div className="term-detail"><span>{tr('Deposited collateral')}</span><b>{money(account.collateral)} USDG</b></div>
        <div className="term-detail"><span>{tr('Wallet USDG')}</span><b>{money(account.wallet)} USDG</b></div>
        <label className="term-field">{tr('Additional margin')}
          <div><input aria-label={tr('Additional position margin')} type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /><span>USDG</span></div>
        </label>
        <p className="term-modal-warning">{tr('More margin lowers your effective leverage and moves the liquidation price away. The position size does not change. Anything not already deposited is deposited from your wallet first.')}</p>
        {error && <p className="term-form-error" role="alert">{tr(error)}</p>}
        <TxProgress step={t.trader.step} hash={t.trader.hash} />
        <button className="term-primary" type="submit" disabled={t.trader.busy}>{tr('Add margin')} +</button>
      </form>
    </Modal>
  );
}

export function ProtectionDialog({ symbol, account, orders, market }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const position = account.positions.find((p) => p.symbol === symbol);
  const current = protectionFor(symbol, orders);
  const digits = priceDigits(position?.mark ?? market?.price ?? 1);
  // A level the position does not have yet starts from the trader's saved defaults; every value stays editable.
  const { presets, update: savePreset, reset: resetPresets } = usePresets();
  const fromDefaults = position ? presetLevels(position.side, position.mark, presets, digits) : { tp: '', sl: '' };
  const [tp, setTp] = useState(current.takeProfit ? String(current.takeProfit.trigger) : fromDefaults.tp);
  const [sl, setSl] = useState(current.stopLoss ? String(current.stopLoss.trigger) : fromDefaults.sl);
  const { error, setError, submit } = useDialogAction(() => t.setDialog(null));
  if (!position) return <Modal title={tr('Position protection')} onClose={() => t.setDialog(null)}><p className="term-modal-intro">{tr('Open a position first: take-profit and stop-loss orders protect an existing position.')}</p></Modal>;
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
    <Modal title={tr(`Position protection · ${symbol}`)} onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <form onSubmit={save}>
        <div className="term-detail"><span>{tr('Current mark')}</span><b>{money(position.mark, digits)} USDG</b></div>
        <div className="term-detail"><span>{tr('Applies to')}</span><b>{tr('Your whole {side} position', { side: tr(position.side.toUpperCase()) })}</b></div>
        <div className="term-protection-form">
          <label className="term-field">{tr('Take-profit trigger')}<div><input aria-label={tr('Position take profit trigger')} type="number" min="0" step="any" value={tp} onChange={(e) => setTp(e.target.value)} placeholder={tr('Optional')} /><span>USDG</span></div></label>
          <label className="term-field">{tr('Stop-loss trigger')}<div><input aria-label={tr('Position stop loss trigger')} type="number" min="0" step="any" value={sl} onChange={(e) => setSl(e.target.value)} placeholder={tr('Optional')} /><span>USDG</span></div></label>
        </div>
        {(!current.takeProfit || !current.stopLoss) && <PresetControls presets={presets} update={savePreset} reset={resetPresets} canEdit={false} onApply={() => { if (!current.takeProfit) setTp(fromDefaults.tp); if (!current.stopLoss) setSl(fromDefaults.sl); }} />}
        <p className="term-modal-warning">{tr('Each level is a signed order that closes the whole position when the mark reaches it; it can only reduce, never open or reverse. A keeper carries it out, so a fast gap or an unavailable quote can fill beyond the trigger or delay it. It lapses after 30 days and when the position closes. Each changed level asks for one signature.')}</p>
        {error && <p className="term-form-error" role="alert">{tr(error)}</p>}
        <TxProgress step={t.trader.step} hash={t.trader.hash} />
        <div className="term-modal-actions">
          <button className="term-secondary" type="button" disabled={t.trader.busy} onClick={() => { setTp(''); setSl(''); }}>{tr('Clear levels')}</button>
          <button className="term-primary" type="submit" disabled={t.trader.busy}>{tr('Save protection')} <Arrow /></button>
        </div>
      </form>
    </Modal>
  );
}

export function CancelOrderDialog({ nonce, orders }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const order = orders.find((o) => o.nonceText === nonce);
  const [onChain, setOnChain] = useState(false);
  const { error, submit } = useDialogAction(() => t.setDialog(null));
  if (!order) return <Modal title={tr('Cancel order')} onClose={() => t.setDialog(null)}><p className="term-modal-intro">{tr('This order is no longer open.')}</p></Modal>;
  return (
    <Modal title={tr('Cancel order')} onClose={() => t.setDialog(null)} busy={t.trader.busy}>
      <div className="term-detail"><span>{tr('Order')}</span><b>{order.symbol} · {tr(order.label, null, 'order type')}{order.side ? ` · ${tr(order.side.toUpperCase())}` : ''}</b></div>
      <div className="term-detail"><span>{tr(order.kind === 4 ? 'Opens' : 'Trigger')}</span><b>{order.kind === 4 ? (order.startsAt && order.startsAt > Date.now() ? tr(relativeTime(order.startsAt)) : tr('now')) : `${order.triggerAbove ? '≥' : '≤'} ${money(order.trigger, priceDigits(order.trigger))}`}</b></div>
      <p className="term-modal-warning">{tr('Cancelling asks for a free signature and removes the order from the queue at once.')} {tr(order.protective ? 'Your position is then no longer protected by this level.' : 'Reserved margin is released.')}</p>
      <label className="term-checkbox"><input type="checkbox" checked={onChain} onChange={(e) => setOnChain(e.target.checked)} />{tr('Also cancel on-chain')} <span>{tr('costs gas')}</span></label>
      <p className="term-fineprint">{tr('The on-chain cancel is the only one that also stops a keeper that has already picked the order up. Use it for an order that is about to trigger.')}</p>
      <TxProgress step={t.trader.step} hash={t.trader.hash} />
      {error && <p className="term-form-error" role="alert">{tr(error)}</p>}
      <button className="term-primary" disabled={t.trader.busy} onClick={() => submit(async (ctx) => { await cancelOrderRequest(ctx, order.nonce); if (onChain) await cancelOrderOnChain(ctx, order.nonce); }, 'Order cancelled.')}>{tr('Cancel order')}</button>
    </Modal>
  );
}

export function RiskDialog({ symbol, account }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const p = account.positions.find((x) => x.symbol === symbol);
  if (!p) return <Modal title={tr('Isolated margin')} onClose={() => t.setDialog(null)}><p className="term-modal-intro">{tr('No open position in {symbol}.', { symbol })}</p></Modal>;
  const digits = priceDigits(p.mark || p.entry);
  const rows = [['Position equity', `${money(p.equity)} USDG`], [`Maintenance · ${money(p.maintenanceBps / 100, 1)}%`, `${money(p.maintenance)} USDG`], ['Equity above maintenance', `${money(p.buffer)} USDG`], ['Gross exposure', `${money(p.notional)} USDG`], ['Estimated liquidation price', p.liquidation === null ? '—' : money(p.liquidation, digits)], ['Distance to estimated liquidation', p.distancePercent === null ? '—' : `${money(p.distancePercent, 1)}%`], ['Effective leverage', Number.isFinite(p.effectiveLeverage) ? `${money(p.effectiveLeverage, 2)}×` : 'No positive equity'], ['Entry / mark', `${money(p.entry, digits)} / ${money(p.mark, digits)}`]];
  return (
    <Modal title={tr(`Isolated margin · ${symbol}`)} onClose={() => t.setDialog(null)}>
      <div className="term-risk-modal-score"><strong>{money(p.healthPercent, 1)}%</strong><span>{tr('Buffer ratio')}<small>{tr(p.status)}</small></span></div>
      {rows.map(([label, value]) => <div className="term-detail" key={label}><span>{tr(label)}</span><b>{tr(value)}</b></div>)}
      <p className="term-modal-warning">{tr("Buffer ratio = (position equity − maintenance) / position equity. The liquidation price is an estimate from the contract's maintenance rate. Borrow accrued since opening, settled on-chain, moves the real level closer.")}</p>
      <div className="term-modal-actions">
        <button className="term-secondary" onClick={() => t.setDialog({ type: 'protection', symbol })}>{tr('Edit TP / SL')}</button>
        <button className="term-primary" onClick={() => t.setDialog({ type: 'margin', symbol })}>{tr('Add margin')} +</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- information

export function SourcesDialog({ market }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const q = useSources(market.symbol, true);
  const s = q.data;
  const labels = { chainlink: 'Chainlink equity feed', rh_quote: 'Robinhood Stock Token quote', pyth: 'Pyth', uni_v3: 'Uniswap v3 pool', uni_v4: 'Uniswap v4 pool' };
  return (
    <Modal title={tr('Why this mark?')} onClose={() => t.setDialog(null)}>
      <p className="term-modal-intro">{tr("Every mark is signed by independent signers. Where Chainlink has a feed for the stock, it must agree with Robinhood's quote before a new position can open; stocks without a feed are priced from Robinhood's quote alone. If sources disagree or go stale, opens stop and exits stay available.")}</p>
      <div className="term-detail"><span>{tr('Market state')}</span><b>{tr(market.statusLabel)}</b></div>
      <div className="term-detail"><span>{tr('Mark')}</span><b>{market.price ? money(market.price, priceDigits(market.price)) : '—'} USDG</b></div>
      <div className="term-detail"><span>{tr('Source agreement')}</span><b>{market.dispersionBps === null ? '—' : tr('{bps} bps apart', { bps: market.dispersionBps })}</b></div>
      {q.isLoading && <div className="term-empty">{tr('Loading sources…')}</div>}
      {q.isError && <p className="term-form-error" role="status">{tr('The price service did not answer.')} {tr(friendlyError(q.error))}</p>}
      {s?.sources?.map((row) => (
        <div className="term-source-row" key={row.source}>
          <div><strong>{tr(labels[row.source] ?? row.source)}</strong><small>{tr('updated {n}s ago', { n: Math.round(row.ageMs / 1000) })}</small></div>
          <b>{money(e18Num(row.priceE18), priceDigits(e18Num(row.priceE18)))}</b>
        </div>
      ))}
      {s && !s.sources?.length && <div className="term-empty">{tr('No source has reported a price yet.')}</div>}
      {s?.halted && <p className="term-modal-warning">{tr(`Trading in this stock is halted${s.haltReason ? ` (${s.haltReason})` : ''}. New positions are stopped; exits stay available.`)}</p>}
      {market.freezeReasons.length > 0 && <p className="term-modal-warning">{tr('Frozen: {reasons}.', { reasons: market.freezeReasons.map((x) => tr(x)).join(', ') })}</p>}
      {market.warnings.length > 0 && <p className="term-modal-warning">{tr('Listing check: {reasons}.', { reasons: market.warnings.map((x) => tr(x)).join('; ') })}</p>}
      <a className="term-primary term-link-btn" href="/docs?topic=mechanics">{tr('Read the pricing method')} <Arrow /></a>
    </Modal>
  );
}

export function CapacityDialog({ market }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const l = market.limits;
  return (
    <Modal title={tr('Size follows the loss budget')} onClose={() => t.setDialog(null)}>
      <p className="term-modal-intro">{tr('The Counter, a shared pool, takes the other side of every trade, so each market can only carry so much. These figures come from the contract, right now.')}</p>
      {l ? <>
        <div className="term-detail"><span>{tr('Counter NAV')}</span><b>{money(l.nav, 0)} USDG</b></div>
        <div className="term-detail"><span>{tr('Largest single position')}</span><b>{money(l.positionCap, 0)} USDG</b></div>
        <div className="term-detail"><span>{tr('Room to go long')}</span><b>{money(l.longRoom, 0)} USDG</b></div>
        <div className="term-detail"><span>{tr('Room to go short')}</span><b>{money(l.shortRoom, 0)} USDG</b></div>
        <div className="term-detail"><span>{tr('Open interest long / short')}</span><b>{money(l.longOi, 0)} / {money(l.shortOi, 0)} USDG</b></div>
      </> : <div className="term-empty">{tr('Limits are unavailable right now.')}</div>}
      <p className="term-modal-warning">{tr('More leverage does not raise the position cap. Room shrinks as the Counter takes on one-sided exposure, and grows as it is balanced.')}</p>
      <button className="term-primary" onClick={() => { t.setDialog(null); t.changeView('Counter'); }}>{tr('Explore the Counter')} <Arrow /></button>
    </Modal>
  );
}

export function AlertDialog({ market }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const [direction, setDirection] = useState('Above');
  const [price, setPrice] = useState(market.price ? market.price.toFixed(priceDigits(market.price)) : '');
  return (
    <Modal title={tr('Create a price alert')} onClose={() => t.setDialog(null)}>
      <form onSubmit={(event) => {
        event.preventDefault();
        const value = Number(price);
        if (!Number.isFinite(value) || value <= 0) return t.notify('Enter a valid alert price.');
        t.addAlert({ id: Date.now(), symbol: market.symbol, direction, price: value });
        t.setDialog(null);
        t.notify(`Alert saved. You will be told here when ${market.symbol} goes ${direction.toLowerCase()} ${money(value, priceDigits(value))}.`);
      }}>
        <div className="term-detail"><span>{tr('Market')}</span><b>{market.symbol} / USDG</b></div>
        <label className="term-field">{tr('Condition')}<div><select aria-label={tr('Alert direction')} value={direction} onChange={(e) => setDirection(e.target.value)}><option value="Above">{tr('Above')}</option><option value="Below">{tr('Below')}</option></select></div></label>
        <label className="term-field">{tr('Trigger price')}<div><input type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} required /><span>USDG</span></div></label>
        <p className="term-modal-warning">{tr('Alerts live in this browser and fire only while this page is open. They do not send email, Telegram or webhook messages.')}</p>
        <button className="term-primary" type="submit">{tr('Save alert')} +</button>
      </form>
    </Modal>
  );
}

export function ShortcutsDialog() {
  const t = useTerminal();
  const { t: tr } = useI18n();
  return (
    <Modal title={tr('Move through your workspace')} onClose={() => t.setDialog(null)}>
      <p className="term-modal-intro">{tr('Shortcuts select controls; they never submit a trade.')}</p>
      <div className="term-shortcut-list">
        {[['Ctrl / ⌘ K or /', 'Search markets and workspaces'], ['F', 'Toggle focus layout'], ['B / S', 'Choose Long / Short'], ['?', 'Open this shortcut guide'], ['Escape', 'Close dialog or exit focus']].map(([keys, action]) => <div key={keys}><span>{tr(action)}</span><kbd>{keys}</kbd></div>)}
      </div>
    </Modal>
  );
}

export function CommandMenu({ markets }) {
  const t = useTerminal();
  const { t: tr } = useI18n();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const choices = [
    ...markets.map((m) => ({ title: `${m.symbol} / USDG`, detail: m.name, action: () => t.chooseMarket(m.symbol) })),
    ...['Trade', 'Counter', 'Tape', 'Ledger', 'Rewards'].map((view) => ({ title: `Go to ${view}`, detail: 'Workspace', action: () => { t.changeView(view); t.setDialog(null); } })),
  ].filter((item) => `${item.title} ${item.detail} ${tr(item.title)} ${tr(item.detail)}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <Modal title={tr('Jump to a market or workspace')} onClose={() => t.setDialog(null)}>
      <div className="term-command-search">
        <span>⌕</span>
        <input autoFocus aria-label={tr('Search commands and markets')} placeholder={tr('Search symbol, company or workspace…')} value={query}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) e.preventDefault();
            if (e.key === 'ArrowDown') setIndex((v) => Math.min(choices.length - 1, v + 1));
            if (e.key === 'ArrowUp') setIndex((v) => Math.max(0, v - 1));
            if (e.key === 'Enter') choices[index]?.action();
          }} />
      </div>
      <div className="term-command-results">
        {choices.map((item, i) => <button key={item.title} className={index === i ? 'active' : ''} onClick={item.action}><span><b>{tr(item.title)}</b><small>{tr(item.detail)}</small></span><span>↵</span></button>)}
        {!choices.length && <p>{tr('No matching market or workspace.')}</p>}
      </div>
      <p className="term-command-help">{tr('↑ ↓ Navigate · Enter select · Esc close')}</p>
    </Modal>
  );
}
